import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { cancelMembership } from '@/domain/membership/service';
import { auditContextFrom } from '@/lib/audit';

type Params = { membershipId: string };

const bodySchema = z.object({ reason: z.string().max(500).optional() });

/**
 * POST /api/v1/memberships/:membershipId/cancel
 *
 * Spec 2.9: subject to that club's notice period, with refund/carryover
 * following the club's configured policy. The verdict tells the member exactly
 * when the membership ends and what (if anything) comes back.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  const membership = await prisma.membership.findUnique({
    where: { id: params.membershipId },
    select: { playerProfileId: true },
  });
  if (membership) await assertOwnsPlayerProfile(actor, membership.playerProfileId);

  const { verdict, waitlistEntryToPromote } = await cancelMembership({
    membershipId: params.membershipId,
    actorAccountId: actor.accountId,
    reason: body.reason,
    context,
  });

  return ok({
    ...verdict,
    // Surfaced so the club dashboard can offer a one-tap promotion.
    waitlistEntryToPromote,
  });
});
