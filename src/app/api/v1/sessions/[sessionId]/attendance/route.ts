import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertCanManageSession } from '@/lib/auth/rbac';
import { syncAttendance } from '@/domain/attendance/service';
import { auditContextFrom } from '@/lib/audit';

type Params = { sessionId: string };

const bodySchema = z.object({
  entries: z
    .array(
      z.object({
        playerProfileId: z.string().min(1),
        status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']),
        /** When the coach tapped, per the device clock. */
        recordedAtDevice: z.string().datetime(),
        /** Client-generated UUID — the idempotency key for this mark. */
        clientMutationId: z.string().min(8).max(64),
        checkInTime: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(200),
});

/**
 * POST /api/v1/sessions/:sessionId/attendance
 *
 * Spec 4.3: the offline sync endpoint. The coach's device queues marks locally
 * and POSTs the whole queue when connectivity returns.
 *
 * Safe to replay — which matters, because the response to the first attempt is
 * exactly what a bad connection loses. `acknowledgedMutationIds` tells the
 * device precisely which queue items to drop, including ones that were rejected
 * outright, so a permanently-invalid mark cannot block the queue forever.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  await assertCanManageSession(actor, params.sessionId);

  // Owners marking attendance still need a coach record to attribute it to —
  // spec 6 requires attendance to record who marked it.
  const coachId = actor.coachIds[0];
  if (!coachId) {
    throw ApiError.forbidden(
      'Attendance must be recorded against a coach profile. Add yourself as a coach to mark attendance.',
    );
  }

  const result = await syncAttendance({
    sessionId: params.sessionId,
    coachId,
    entries: body.entries,
    context,
  });

  return ok(result);
});
