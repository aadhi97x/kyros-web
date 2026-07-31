import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { pauseMembership, resumeMembership } from '@/domain/membership/service';
import { auditContextFrom } from '@/lib/audit';

type Params = { membershipId: string };

const bodySchema = z.object({
  reason: z.enum(['INJURY', 'ILLNESS', 'TRAVEL', 'OTHER']),
  reasonNote: z.string().max(500).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  hasProof: z.boolean().default(false),
});

async function assertOwnsMembership(actorAccountId: string, membershipId: string) {
  const membership = await prisma.membership.findUnique({
    where: { id: membershipId },
    select: { playerProfileId: true },
  });
  if (!membership) return null;
  return membership.playerProfileId;
}

/**
 * POST /api/v1/memberships/:membershipId/pause
 *
 * Spec 2.9. The club's pause policy is enforced server-side — the response
 * explains exactly what the member gets, per that club's carryover setting.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  const playerProfileId = await assertOwnsMembership(actor.accountId, params.membershipId);
  if (playerProfileId) await assertOwnsPlayerProfile(actor, playerProfileId);

  const verdict = await pauseMembership({
    membershipId: params.membershipId,
    actorAccountId: actor.accountId,
    ...body,
    context,
  });

  return ok(verdict);
});

/** DELETE /api/v1/memberships/:membershipId/pause — resume early. */
export const DELETE = authedRoute<Params>(async ({ request, params, actor }) => {
  const context = auditContextFrom(request);

  const playerProfileId = await assertOwnsMembership(actor.accountId, params.membershipId);
  if (playerProfileId) await assertOwnsPlayerProfile(actor, playerProfileId);

  return ok(
    await resumeMembership({
      membershipId: params.membershipId,
      actorAccountId: actor.accountId,
      context,
    }),
  );
});
