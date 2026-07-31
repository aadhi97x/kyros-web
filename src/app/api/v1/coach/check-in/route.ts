import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { recordCoachCheckIn } from '@/domain/attendance/service';
import { auditContextFrom } from '@/lib/audit';

const bodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  centreId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(10_000).optional(),
});

/**
 * POST /api/v1/coach/check-in
 *
 * Spec 4.2: the geofenced "I'm here". The centre's radius and the club's
 * enforcement mode (reject / flag for review / off) come from configuration;
 * the distance and lateness recorded here feed the owner's punctuality
 * analytics.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  const coachId = actor.coachIds[0];
  if (!coachId) throw ApiError.forbidden('Only coaches can check in.');

  const result = await recordCoachCheckIn({
    coachId,
    sessionId: body.sessionId,
    centreId: body.centreId,
    latitude: body.latitude,
    longitude: body.longitude,
    accuracyM: body.accuracyM,
    context,
  });

  return ok(result);
});
