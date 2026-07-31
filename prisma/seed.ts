/**
 * Development seed.
 *
 * Creates two clubs with deliberately OPPOSITE configurations, because the
 * whole product hinges on the member flow branching correctly:
 *
 *   • Bengaluru Strikers FC — demos required, coach-assigned batches, approval
 *     gate, part payment, waitlist. The maximally-gated path.
 *   • Kochi Coastal Academy — no demo, member self-select, auto-confirm, pay in
 *     full, no waitlist. The straight-through path.
 *
 * Running the enrollment state machine against both is the fastest way to see
 * whether a change broke the config engine.
 *
 * Never run against production: it deletes everything first.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { applyConfigPatch, defaultClubConfig, serialiseClubConfig } from '../src/domain/config/engine';
import { deriveIsMinor } from '../src/domain/player/age';

const prisma = new PrismaClient();

const PASSWORD = 'kyros-dev-2026';

function yearsAgo(years: number): Date {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date;
}

/** 0 = Sunday. Minutes from midnight. */
function schedule(days: number[], startMinute: number, durationMinutes = 90) {
  return days.map((dayOfWeek) => ({
    dayOfWeek,
    startMinute,
    endMinute: startMinute + durationMinutes,
  }));
}

async function reset() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }
  // Order matters — children before parents.
  await prisma.$transaction([
    prisma.auditEvent.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.chatMessage.deleteMany(),
    prisma.chatParticipant.deleteMany(),
    prisma.chatThread.deleteMany(),
    prisma.walletEntry.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.instalment.deleteMany(),
    prisma.membershipPause.deleteMany(),
    prisma.membershipAddOn.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.waitlistEntry.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.attendance.deleteMany(),
    prisma.coachCheckIn.deleteMany(),
    prisma.session.deleteMany(),
    prisma.demoBooking.deleteMany(),
    prisma.demoSlot.deleteMany(),
    prisma.packageAddOn.deleteMany(),
    prisma.package.deleteMany(),
    prisma.batchSchedule.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.coachAvailability.deleteMany(),
    prisma.coachCentre.deleteMany(),
    prisma.coach.deleteMany(),
    prisma.centre.deleteMany(),
    prisma.booking.deleteMany(),
    prisma.venueBlock.deleteMany(),
    prisma.venueAvailability.deleteMany(),
    prisma.venue.deleteMany(),
    prisma.club.deleteMany(),
    prisma.consentRecord.deleteMany(),
    prisma.playerProfile.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.otpChallenge.deleteMany(),
    prisma.device.deleteMany(),
    prisma.account.deleteMany(),
  ]);
}

async function main() {
  console.info('Resetting database…');
  await reset();

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = {
    passwordHash,
    status: 'ACTIVE' as const,
    phoneVerifiedAt: new Date(),
  };

  console.info('Creating accounts…');

  const owner = await prisma.account.create({
    data: { ...base, name: 'Ravi Menon', phone: '+919800000001', email: 'ravi@strikers.test', role: 'CLUB_OWNER', type: 'UNSET' },
  });
  const owner2 = await prisma.account.create({
    data: { ...base, name: 'Anjali Nair', phone: '+919800000002', email: 'anjali@coastal.test', role: 'CLUB_OWNER', type: 'UNSET' },
  });
  const coachAccount = await prisma.account.create({
    data: { ...base, name: 'Suresh Kumar', phone: '+919800000003', email: 'suresh@strikers.test', role: 'COACH', type: 'UNSET' },
  });
  const parent = await prisma.account.create({
    data: { ...base, name: 'Priya Sharma', phone: '+919800000010', email: 'priya@example.test', role: 'MEMBER', type: 'GUARDIAN', origin: 'GUARDIAN_SIGNUP', walletBalancePaise: 50_000 },
  });
  const adultPlayer = await prisma.account.create({
    data: { ...base, name: 'Arjun Das', phone: '+919800000011', email: 'arjun@example.test', role: 'MEMBER', type: 'ADULT_PLAYER', origin: 'ADULT_SIGNUP' },
  });
  const venueOwner = await prisma.account.create({
    data: { ...base, name: 'Faizal Rahman', phone: '+919800000020', email: 'faizal@turf.test', role: 'VENUE_OWNER', type: 'UNSET' },
  });
  await prisma.account.create({
    data: { ...base, name: 'Platform Admin', phone: '+919800000099', email: 'admin@kyros.test', role: 'PLATFORM_ADMIN', type: 'UNSET' },
  });

  console.info('Creating player profiles…');

  const aarav = await prisma.playerProfile.create({
    data: {
      accountId: parent.id,
      fullName: 'Aarav Sharma',
      dateOfBirth: yearsAgo(11),
      gender: 'MALE',
      positions: ['Midfielder'],
      preferredFoot: 'RIGHT',
      emergencyName: 'Priya Sharma',
      emergencyPhone: '+919800000010',
      emergencyRelation: 'Mother',
      isMinor: deriveIsMinor(yearsAgo(11)),
    },
  });

  const diya = await prisma.playerProfile.create({
    data: {
      accountId: parent.id,
      fullName: 'Diya Sharma',
      dateOfBirth: yearsAgo(8),
      gender: 'FEMALE',
      positions: ['Forward'],
      emergencyName: 'Priya Sharma',
      emergencyPhone: '+919800000010',
      isMinor: deriveIsMinor(yearsAgo(8)),
    },
  });

  const arjunProfile = await prisma.playerProfile.create({
    data: {
      accountId: adultPlayer.id,
      fullName: 'Arjun Das',
      dateOfBirth: yearsAgo(26),
      gender: 'MALE',
      positions: ['Defender'],
      isMinor: false,
    },
  });

  // Consent for one child only — so the enrollment state machine has a live
  // CONSENT_REQUIRED case to hit with the other.
  await prisma.consentRecord.create({
    data: {
      playerProfileId: aarav.id,
      consentingAccountId: parent.id,
      scopes: ['ENROLLMENT_ADMIN', 'ATTENDANCE_RECORDS', 'COACH_ASSESSMENTS', 'MEDICAL_EMERGENCY'],
      noticeVersion: '2026-01-15.v1',
      noticeText: 'Seeded consent record — see src/domain/consent/scopes.ts for the real notice.',
      verificationMethod: 'MOCK',
      verificationReference: 'mock_seed_reference',
      verifiedAt: new Date(),
      state: 'ACTIVE',
    },
  });
  await prisma.account.update({ where: { id: parent.id }, data: { hasConsentOnFile: true } });

  console.info('Creating clubs…');

  // --- Club A: every gate switched on ---------------------------------------
  const strictConfig = applyConfigPatch(defaultClubConfig(), {
    demo: { enabled: true, requiredBeforeEnrollment: true, feePaise: 20_000, bookingWindowDays: 21 },
    enrollment: {
      batchAssignment: 'COACH_ASSIGNED',
      approval: 'REQUIRED',
      waitlistEnabled: true,
      waitlistMaxSize: 20,
      trialClassEnabled: false,
    },
    payments: { partPaymentAllowed: true, partPaymentSplits: 3, partPaymentUpfrontBps: 4000 },
    pause: { allowed: true, minDays: 14, maxDaysPerYear: 60, noticeDays: 5 },
    refunds: { carryover: 'CARRYOVER_CREDIT', refundIfNeverAttended: true, cancellationNoticeDays: 30 },
    attendance: { absenteeFollowUpAfterMisses: 3, absenteeLookbackDays: 30 },
    communication: { chatEnabled: true, batchChatEnabled: true, directChatEnabled: true },
  });

  const strikers = await prisma.club.create({
    data: {
      ownerAccountId: owner.id,
      name: 'Bengaluru Strikers FC',
      slug: 'bengaluru-strikers-fc',
      description:
        'Grassroots to elite pathway in south Bengaluru. Demo-first admissions, coach-led batch placement.',
      contactEmail: 'hello@strikers.test',
      contactPhone: '+919800000001',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      trainingMode: 'BOTH',
      setupStep: 10,
      ratingAverage: 4.6,
      ratingCount: 84,
      config: serialiseClubConfig(strictConfig) as Prisma.InputJsonObject,
    },
  });

  const strikersCentre = await prisma.centre.create({
    data: {
      clubId: strikers.id,
      name: 'Koramangala Ground',
      address: '80 Feet Road, Koramangala 4th Block',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560034',
      latitude: 12.9345,
      longitude: 77.6266,
      geofenceRadiusM: 120,
      capacity: 60,
      amenities: ['Floodlights', 'Changing rooms', 'Parking', 'Drinking water'],
    },
  });

  const coach = await prisma.coach.create({
    data: {
      clubId: strikers.id,
      accountId: coachAccount.id,
      name: 'Suresh Kumar',
      qualification: 'AFC B Licence',
      bio: 'Fourteen years coaching youth football across Karnataka.',
      phone: '+919800000003',
      centres: { create: { centreId: strikersCentre.id } },
      availability: {
        create: schedule([1, 3, 5], 16 * 60).map((slot) => ({
          dayOfWeek: slot.dayOfWeek,
          startMinute: slot.startMinute,
          endMinute: slot.endMinute + 60,
        })),
      },
    },
  });

  const u12 = await prisma.batch.create({
    data: {
      clubId: strikers.id,
      centreId: strikersCentre.id,
      coachId: coach.id,
      name: 'U-12 Development',
      mode: 'ACADEMY',
      type: 'GENERAL',
      minAge: 9,
      maxAge: 12,
      skillLevel: 'BEGINNER',
      capacity: 24,
      activeCount: 18,
      entryRules: 'Demo session required. Coach places the player after assessment.',
      schedule: { create: schedule([1, 3, 5], 16 * 60) },
    },
  });

  // A deliberately FULL batch, so the waitlist branch is reachable in the app.
  const u16Elite = await prisma.batch.create({
    data: {
      clubId: strikers.id,
      centreId: strikersCentre.id,
      coachId: coach.id,
      name: 'U-16 Elite Squad',
      mode: 'ACADEMY',
      type: 'ELITE',
      minAge: 13,
      maxAge: 16,
      skillLevel: 'ADVANCED',
      capacity: 18,
      activeCount: 18,
      entryRules: 'Trials only. Minimum 80% attendance commitment.',
      schedule: { create: schedule([2, 4, 6], 17 * 60, 120) },
    },
  });

  await prisma.package.create({
    data: {
      clubId: strikers.id,
      batchId: u12.id,
      tierName: 'U-12 Monthly',
      description: 'Three sessions a week, coach feedback every month.',
      mode: 'ACADEMY',
      billingType: 'MONTHLY',
      pricePaise: 280_000,
      registrationFeePaise: 150_000,
      partPaymentAllowed: true,
      partPaymentSplits: 3,
      inclusions: ['3 sessions/week', 'Monthly progress note', 'Match-day selection'],
      addOns: {
        create: [
          { name: 'Club jersey', pricePaise: 120_000, mandatory: true, oneTime: true },
          { name: 'Training kit', pricePaise: 250_000, mandatory: false, oneTime: true },
        ],
      },
    },
  });

  await prisma.package.create({
    data: {
      clubId: strikers.id,
      batchId: u16Elite.id,
      tierName: 'Elite Term (3 months)',
      mode: 'ACADEMY',
      billingType: 'TERM',
      termMonths: 3,
      pricePaise: 1_200_000,
      registrationFeePaise: 200_000,
      partPaymentAllowed: true,
      partPaymentSplits: 3,
      inclusions: ['4 sessions/week', 'Strength & conditioning', 'Quarterly report', 'Tournament entry'],
    },
  });

  // Credits-mode package on the same club — spec design principle 4: mode lives
  // on the batch, so one club runs both models side by side.
  const adultBatch = await prisma.batch.create({
    data: {
      clubId: strikers.id,
      centreId: strikersCentre.id,
      coachId: coach.id,
      name: 'Adult Drop-in',
      mode: 'CREDITS',
      type: 'GENERAL',
      minAge: 18,
      maxAge: 45,
      skillLevel: 'INTERMEDIATE',
      capacity: 30,
      activeCount: 11,
      schedule: { create: schedule([0, 6], 7 * 60) },
    },
  });

  await prisma.package.create({
    data: {
      clubId: strikers.id,
      batchId: adultBatch.id,
      tierName: '10-session pack',
      mode: 'CREDITS',
      billingType: 'CREDIT_PACK',
      pricePaise: 400_000,
      creditSessions: 10,
      inclusions: ['Valid 6 months', 'Book any weekend slot'],
    },
  });

  // Demo slots for the next fortnight.
  const demoSlots: Prisma.DemoSlotCreateManyInput[] = [];
  for (let day = 2; day <= 14; day += 3) {
    const startsAt = new Date();
    startsAt.setDate(startsAt.getDate() + day);
    startsAt.setHours(16, 0, 0, 0);
    const endsAt = new Date(startsAt);
    endsAt.setHours(17, 30, 0, 0);
    demoSlots.push({
      clubId: strikers.id,
      centreId: strikersCentre.id,
      startsAt,
      endsAt,
      capacity: 6,
      bookedCount: 0,
    });
  }
  await prisma.demoSlot.createMany({ data: demoSlots });

  // --- Club B: straight-through path ---------------------------------------
  const relaxedConfig = applyConfigPatch(defaultClubConfig(), {
    demo: { enabled: false },
    enrollment: {
      batchAssignment: 'MEMBER_SELF_SELECT',
      approval: 'AUTO_CONFIRM_ON_PAYMENT',
      waitlistEnabled: false,
      trialClassEnabled: true,
      trialClassCount: 2,
    },
    payments: { partPaymentAllowed: false },
    pause: { allowed: false },
    refunds: { carryover: 'NEITHER', refundIfNeverAttended: false, cancellationNoticeDays: 7 },
    communication: { chatEnabled: true, batchChatEnabled: true, directChatEnabled: false },
  });

  const coastal = await prisma.club.create({
    data: {
      ownerAccountId: owner2.id,
      name: 'Kochi Coastal Academy',
      slug: 'kochi-coastal-academy',
      description: 'Join today, train tomorrow. Two free trial classes, pick your own batch.',
      contactEmail: 'hello@coastal.test',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      trainingMode: 'ACADEMY',
      setupStep: 10,
      ratingAverage: 4.2,
      ratingCount: 31,
      config: serialiseClubConfig(relaxedConfig) as Prisma.InputJsonObject,
    },
  });

  const coastalCentre = await prisma.centre.create({
    data: {
      clubId: coastal.id,
      name: 'Marine Drive Turf',
      address: 'Marine Drive, Ernakulam',
      city: 'Kochi',
      state: 'Kerala',
      pincode: '682031',
      latitude: 9.9816,
      longitude: 76.2772,
      capacity: 40,
      amenities: ['Floodlights', 'Cafeteria', 'Drinking water'],
    },
  });

  const coastalCoach = await prisma.coach.create({
    data: {
      clubId: coastal.id,
      name: 'Meera Thomas',
      qualification: 'AIFF D Licence',
      centres: { create: { centreId: coastalCentre.id } },
    },
  });

  const juniors = await prisma.batch.create({
    data: {
      clubId: coastal.id,
      centreId: coastalCentre.id,
      coachId: coastalCoach.id,
      name: 'Juniors (7–10)',
      mode: 'ACADEMY',
      type: 'GENERAL',
      minAge: 7,
      maxAge: 10,
      skillLevel: 'BEGINNER',
      capacity: 20,
      activeCount: 6,
      schedule: { create: schedule([2, 4], 16 * 60 + 30) },
    },
  });

  await prisma.package.create({
    data: {
      clubId: coastal.id,
      batchId: juniors.id,
      tierName: 'Juniors Monthly',
      mode: 'ACADEMY',
      billingType: 'MONTHLY',
      pricePaise: 180_000,
      registrationFeePaise: 50_000,
      inclusions: ['2 sessions/week', '2 free trial classes'],
      addOns: { create: [{ name: 'Academy jersey', pricePaise: 90_000, mandatory: false, oneTime: true }] },
    },
  });

  console.info('Creating sessions, memberships and attendance…');

  // Aarav is enrolled and active at Strikers.
  const u12Package = await prisma.package.findFirstOrThrow({ where: { batchId: u12.id } });

  const membership = await prisma.membership.create({
    data: {
      playerProfileId: aarav.id,
      packageId: u12Package.id,
      batchId: u12.id,
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      totalPaise: 550_000,
      paidPaise: 550_000,
      isPartPayment: false,
    },
  });

  await prisma.payment.create({
    data: {
      accountId: parent.id,
      membershipId: membership.id,
      type: 'MEMBERSHIP_FEE',
      status: 'SUCCEEDED',
      method: 'UPI',
      amountPaise: 550_000,
      idempotencyKey: 'seed-membership-aarav',
      paidAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      gatewayPaymentId: 'pay_seed_aarav',
    },
  });

  // Sessions: a fortnight behind and a fortnight ahead.
  const sessionRows: Prisma.SessionCreateManyInput[] = [];
  for (let offset = -14; offset <= 14; offset += 1) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    if (![1, 3, 5].includes(date.getDay())) continue;

    const startsAt = new Date(date);
    startsAt.setHours(16, 0, 0, 0);
    const endsAt = new Date(startsAt);
    endsAt.setHours(17, 30, 0, 0);

    sessionRows.push({
      batchId: u12.id,
      centreId: strikersCentre.id,
      coachId: coach.id,
      startsAt,
      endsAt,
      status: offset < 0 ? 'COMPLETED' : 'SCHEDULED',
      syllabusModule: offset % 2 === 0 ? 'Passing under pressure' : 'First touch and turning',
    });
  }
  await prisma.session.createMany({ data: sessionRows });

  const pastSessions = await prisma.session.findMany({
    where: { batchId: u12.id, status: 'COMPLETED' },
    orderBy: { startsAt: 'asc' },
  });

  // Mixed attendance, with enough absences to populate the absentee list.
  await prisma.attendance.createMany({
    data: pastSessions.map((session, index) => ({
      sessionId: session.id,
      playerProfileId: aarav.id,
      status: index % 4 === 3 ? ('ABSENT' as const) : ('PRESENT' as const),
      source: 'COACH_TAP' as const,
      markedByCoachId: coach.id,
      markedAt: session.endsAt,
      recordedAtDevice: session.startsAt,
    })),
  });

  await prisma.assessment.create({
    data: {
      playerProfileId: aarav.id,
      coachId: coach.id,
      period: 'QUARTERLY',
      skillRatings: { dribbling: 4, passing: 3, shooting: 3, defending: 2, stamina: 4, attitude: 5 },
      notes:
        'Aarav has grown into the midfield role well. Passing range is improving; needs more confidence defending in transition.',
      periodStart: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      periodEnd: new Date(),
      publishedAt: new Date(),
    },
  });

  // Batch group chat.
  const thread = await prisma.chatThread.create({
    data: {
      clubId: strikers.id,
      batchId: u12.id,
      type: 'BATCH_GROUP',
      title: 'U-12 Development',
      participants: {
        create: [
          { accountId: coachAccount.id, role: 'coach' },
          { accountId: parent.id, role: 'member' },
          { accountId: owner.id, role: 'owner' },
        ],
      },
    },
  });

  await prisma.chatMessage.createMany({
    data: [
      {
        threadId: thread.id,
        senderAccountId: coachAccount.id,
        body: 'Reminder: Friday’s session moves to 4:30pm because of the ground booking.',
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
      {
        threadId: thread.id,
        senderAccountId: parent.id,
        body: 'Noted, thank you coach.',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    ],
  });

  console.info('Creating a venue…');

  const venue = await prisma.venue.create({
    data: {
      ownerAccountId: venueOwner.id,
      name: 'Greenfield Turf Arena',
      description: 'Two 5-a-side pitches and one 7-a-side, floodlit until midnight.',
      address: 'HSR Layout Sector 2',
      city: 'Bengaluru',
      state: 'Karnataka',
      latitude: 12.9121,
      longitude: 77.6446,
      surface: 'ARTIFICIAL_TURF',
      sizeLabel: '5-a-side',
      amenities: ['Floodlights', 'Parking', 'Showers'],
      hourlyRatePaise: 150_000,
      status: 'PUBLISHED',
      availability: {
        create: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: 6 * 60,
          endMinute: 23 * 60,
        })),
      },
    },
  });

  console.info(`
Seed complete.

  Password for every seeded account: ${PASSWORD}

  Club owner (gated club)     +919800000001  Bengaluru Strikers FC
  Club owner (open club)      +919800000002  Kochi Coastal Academy
  Coach                       +919800000003  Suresh Kumar
  Parent (2 children)         +919800000010  Priya Sharma
  Adult player                +919800000011  Arjun Das
  Venue owner                 +919800000020  Faizal Rahman
  Platform admin              +919800000099

  Deliberate test cases:
    • ${aarav.fullName} has consent on file and an ACTIVE membership.
    • ${diya.fullName} has NO consent — enrollment stops at CONSENT_REQUIRED.
    • ${arjunProfile.fullName} is an adult — the consent gate is skipped entirely.
    • "U-16 Elite Squad" is FULL (18/18) — enrollment goes to OFFER_WAITLIST.
    • Strikers requires a demo, coach placement and approval; Coastal requires none.
    • Venue "${venue.name}" is published for the Build 2 booking work.
`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
