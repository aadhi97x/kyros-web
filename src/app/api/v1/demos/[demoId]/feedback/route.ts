import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertClubStaff } from '@/lib/auth/rbac';

type Params = { demoId: string };

const bodySchema = z.object({
  coachFeedback: z.string().min(1).max(4000),
  skillRatings: z.record(z.number().int().min(1).max(5)).optional(),
  recommendedBatchId: z.string().min(1).optional(),
  recommendedPackageId: z.string().min(1).optional(),
  status: z.enum(['COMPLETED', 'NO_SHOW']).default('COMPLETED'),
});

/**
 * POST /api/v1/demos/:demoId/feedback
 *
 * Spec 3.8: the coach records feedback, assigns a batch and recommends a
 * package. Spec 2.6: this is exactly what the parent then sees on the
 * post-demo screen, which is why the notification fires from here.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, bodySchema);

  const demo = await prisma.demoBooking.findUnique({
    where: { id: params.demoId },
    select: {
      id: true,
      clubId: true,
      accountId: true,
      playerProfileId: true,
      playerProfile: { select: { fullName: true } },
    },
  });
  if (!demo) throw ApiError.notFound('Demo booking');

  assertClubStaff(actor, demo.clubId);

  const updated = await prisma.demoBooking.update({
    where: { id: demo.id },
    data: {
      status: body.status,
      coachFeedback: body.coachFeedback,
      skillRatings: body.skillRatings,
      recommendedBatchId: body.recommendedBatchId,
      recommendedPackageId: body.recommendedPackageId,
      coachId: actor.coachIds[0],
      feedbackRecordedAt: new Date(),
    },
  });

  // Spec 2.11: routed to the account holder, tagged with the player.
  await prisma.notification.create({
    data: {
      accountId: demo.accountId,
      playerProfileId: demo.playerProfileId,
      type: 'DEMO_UPDATED',
      title: 'Your coach feedback is ready',
      body: `The coach has written up ${demo.playerProfile.fullName}'s demo and recommended a batch.`,
      data: { demoBookingId: demo.id, clubId: demo.clubId },
    },
  });

  return ok({
    id: updated.id,
    status: updated.status,
    feedbackRecordedAt: updated.feedbackRecordedAt,
  });
});
