import { ok } from '@/lib/api/response';
import { authedRoute } from '@/lib/api/handler';
import { assertClubStaff } from '@/lib/auth/rbac';
import { absenteeFollowUpList } from '@/domain/attendance/service';

type Params = { clubId: string };

/**
 * GET /api/v1/clubs/:clubId/absentees
 *
 * Spec 3.7: "auto-generated list of members who have missed a defined number of
 * sessions, with a one-tap message action". The threshold and lookback window
 * come from the club's own config, not a hardcoded constant.
 */
export const GET = authedRoute<Params>(async ({ params, actor }) => {
  assertClubStaff(actor, params.clubId);
  const rows = await absenteeFollowUpList(params.clubId);

  return ok({
    count: rows.length,
    members: rows.map((row) => ({
      ...row,
      // Spec 2.11: notifications route to the account holder, tagged with the
      // player they concern.
      messageTarget: { accountId: row.accountId, aboutPlayerProfileId: row.playerProfileId },
    })),
  });
});
