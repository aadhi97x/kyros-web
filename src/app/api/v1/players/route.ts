import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { deriveIsMinor, ageInYearsOn, validateDateOfBirth } from '@/domain/player/age';
import { getConsentStatus } from '@/domain/consent/service';
import { audit, auditContextFrom } from '@/lib/audit';

const createSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  dateOfBirth: z.coerce.date(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']).default('UNDISCLOSED'),
  photoUrl: z.string().url().max(500).optional(),
  positions: z.array(z.string().max(40)).max(5).default([]),
  preferredFoot: z.enum(['LEFT', 'RIGHT', 'BOTH']).optional(),
  medicalNotes: z.string().max(2000).optional(),
  emergencyName: z.string().max(100).optional(),
  emergencyPhone: z.string().max(20).optional(),
  emergencyRelation: z.string().max(50).optional(),
});

/** GET /api/v1/players — every profile on the calling account (spec 2.2). */
export const GET = authedRoute(async ({ actor }) => {
  const profiles = await prisma.playerProfile.findMany({
    where: { accountId: actor.accountId },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    include: {
      memberships: {
        where: { status: { in: ['ACTIVE', 'PAUSED', 'WAITLISTED', 'PENDING_APPROVAL', 'PENDING_PAYMENT'] } },
        select: {
          id: true,
          status: true,
          batch: { select: { id: true, name: true, club: { select: { id: true, name: true } } } },
        },
      },
    },
  });

  const withConsent = await Promise.all(
    profiles.map(async (profile) => {
      const consent = await getConsentStatus(profile.id);
      return {
        id: profile.id,
        fullName: profile.fullName,
        dateOfBirth: profile.dateOfBirth,
        ageYears: ageInYearsOn(profile.dateOfBirth),
        gender: profile.gender,
        photoUrl: profile.photoUrl,
        positions: profile.positions,
        preferredFoot: profile.preferredFoot,
        emergencyName: profile.emergencyName,
        emergencyPhone: profile.emergencyPhone,
        isMinor: profile.isMinor,
        status: profile.status,
        joinDate: profile.joinDate,
        consent: {
          required: profile.isMinor,
          satisfied: consent.satisfied,
          activeScopes: consent.activeScopes,
          missingRequiredScopes: consent.missingRequiredScopes,
          grantedAt: consent.grantedAt,
        },
        memberships: profile.memberships,
      };
    }),
  );

  return ok(withConsent);
});

/**
 * POST /api/v1/players
 *
 * Spec 2.2: `is_minor` is DERIVED from date of birth. Any `isMinor` a client
 * sends is ignored — the schema does not even accept it.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, createSchema);
  const context = auditContextFrom(request);

  const validation = validateDateOfBirth(body.dateOfBirth);
  if (!validation.ok) throw ApiError.badRequest(validation.problem!);

  const isMinor = deriveIsMinor(body.dateOfBirth);

  // A guardian account can hold several children; an adult-player account is
  // one person, so a second profile there is almost certainly a mistake.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: actor.accountId },
    select: { type: true, _count: { select: { playerProfiles: true } } },
  });

  if (account.type === 'ADULT_PLAYER' && account._count.playerProfiles >= 1) {
    throw ApiError.badRequest(
      'An adult player account holds a single profile. Switch to a parent account to add children.',
    );
  }

  const profile = await prisma.playerProfile.create({
    data: {
      accountId: actor.accountId,
      fullName: body.fullName,
      dateOfBirth: body.dateOfBirth,
      gender: body.gender,
      photoUrl: body.photoUrl,
      positions: body.positions,
      preferredFoot: body.preferredFoot,
      medicalNotes: body.medicalNotes,
      emergencyName: body.emergencyName,
      emergencyPhone: body.emergencyPhone,
      emergencyRelation: body.emergencyRelation,
      isMinor,
    },
    select: { id: true, fullName: true, isMinor: true, dateOfBirth: true },
  });

  await audit({
    action: 'player.created',
    entityType: 'PlayerProfile',
    entityId: profile.id,
    actorAccountId: actor.accountId,
    metadata: { isMinor },
    context,
  });

  return created({
    ...profile,
    ageYears: ageInYearsOn(profile.dateOfBirth),
    // The app must route a minor straight to the consent screen before any
    // further processing of their data (spec 2.3).
    requiresConsent: isMinor,
  });
});
