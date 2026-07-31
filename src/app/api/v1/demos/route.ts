import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody, parseQuery } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { parseClubConfig } from '@/domain/config/engine';
import { hasActiveConsent } from '@/domain/consent/service';

const querySchema = z.object({ clubId: z.string().min(1) });

/**
 * GET /api/v1/demos?clubId=
 *
 * Available demo slots (spec 2.6). Slots outside the club's booking window or
 * inside its minimum-notice period are filtered out here rather than shown and
 * then rejected.
 */
export const GET = authedRoute(async ({ request }) => {
  const { clubId } = parseQuery(request, querySchema);

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { config: true, status: true },
  });
  if (!club || club.status !== 'PUBLISHED') throw ApiError.notFound('Club');

  const config = parseClubConfig(club.config);
  if (!config.demo.enabled) {
    return ok({ demoEnabled: false, slots: [] });
  }

  const earliest = new Date(Date.now() + config.demo.minNoticeHours * 60 * 60 * 1000);
  const latest = new Date(Date.now() + config.demo.bookingWindowDays * 24 * 60 * 60 * 1000);

  const slots = await prisma.demoSlot.findMany({
    where: { clubId, isActive: true, startsAt: { gte: earliest, lte: latest } },
    orderBy: { startsAt: 'asc' },
    include: { centre: { select: { id: true, name: true, address: true, city: true } } },
  });

  return ok({
    demoEnabled: true,
    feePaise: config.demo.feePaise,
    requiredBeforeEnrollment: config.demo.requiredBeforeEnrollment,
    slots: slots
      .filter((slot) => slot.bookedCount < slot.capacity)
      .map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        placesLeft: slot.capacity - slot.bookedCount,
        centre: slot.centre,
      })),
  });
});

const bookSchema = z.object({
  clubId: z.string().min(1),
  playerProfileId: z.string().min(1),
  demoSlotId: z.string().min(1),
  intendedBatchId: z.string().min(1).optional(),
});

/**
 * POST /api/v1/demos
 *
 * Book a demo slot for a specific player profile (spec 2.6). Consent is checked
 * first — a demo booking already processes a minor's data.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, bookSchema);

  await assertOwnsPlayerProfile(actor, body.playerProfileId);

  if (!(await hasActiveConsent(body.playerProfileId))) {
    throw ApiError.consentRequired(
      'Verified guardian consent is required before booking a demo for this player.',
    );
  }

  const booking = await prisma.$transaction(async (tx) => {
    // Atomic claim on the slot, same reasoning as batch capacity: a
    // read-then-check would let two parents take the last place.
    const claimed = await tx.$executeRaw`
      UPDATE "demo_slots"
         SET "bookedCount" = "bookedCount" + 1
       WHERE "id" = ${body.demoSlotId}
         AND "isActive" = true
         AND "bookedCount" < "capacity"
    `;

    if (claimed === 0) {
      throw ApiError.conflict('That demo slot was just taken. Pick another.');
    }

    const slot = await tx.demoSlot.findUniqueOrThrow({
      where: { id: body.demoSlotId },
      select: { startsAt: true, clubId: true },
    });

    return tx.demoBooking.create({
      data: {
        clubId: slot.clubId,
        playerProfileId: body.playerProfileId,
        accountId: actor.accountId,
        demoSlotId: body.demoSlotId,
        intendedBatchId: body.intendedBatchId,
        scheduledAt: slot.startsAt,
        status: 'CONFIRMED',
      },
    });
  });

  await prisma.notification.create({
    data: {
      accountId: actor.accountId,
      playerProfileId: body.playerProfileId,
      type: 'DEMO_CONFIRMED',
      title: 'Demo session confirmed',
      body: `Your demo is booked for ${booking.scheduledAt.toLocaleString('en-IN')}.`,
      data: { demoBookingId: booking.id, clubId: booking.clubId },
    },
  });

  return created({
    id: booking.id,
    status: booking.status,
    scheduledAt: booking.scheduledAt,
  });
});
