import { ok } from '@/lib/api/response';
import { authedRoute } from '@/lib/api/handler';
import { myMemberships } from '@/domain/membership/service';

/**
 * GET /api/v1/memberships
 *
 * Spec 2.9 "My memberships" plus spec 2.8's combined billing view: one wallet
 * and one history for the whole account, not two parallel invoices for a parent
 * with two children.
 */
export const GET = authedRoute(async ({ actor }) => {
  return ok(await myMemberships(actor.accountId));
});
