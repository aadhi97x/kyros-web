import { z } from 'zod';
import { prisma } from '@/lib/db';
import { created, noContent } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { joinWaitlist } from '@/domain/enrollment/service';
import { audit, auditContextFrom } from '@/lib/audit';

const joinSchema = z.object({
  playerProfileId: z.string().min(1),
  clubId: z.string().min(1),
  batchId: z.string().min(1),
  packageId: z.string().min(1).optional(),
});

/** POST /api/v1/enrollment/waitlist — spec 2.7, join a full batch's queue. */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, joinSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, body.playerProfileId);

  const { position } = await joinWaitlist({ ...body, accountId: actor.accountId, context });

  return created({
    position,
    message: `You are number ${position} on the waitlist. We will notify you the moment a place opens.`,
  });
});

const leaveSchema = z.object({
  playerProfileId: z.string().min(1),
  batchId: z.string().min(1),
});

/** DELETE /api/v1/enrollment/waitlist — leave the queue. */
export const DELETE = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, leaveSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, body.playerProfileId);

  const entry = await prisma.waitlistEntry.update({
    where: {
      batchId_playerProfileId: {
        batchId: body.batchId,
        playerProfileId: body.playerProfileId,
      },
    },
    data: { removedAt: new Date() },
    select: { id: true },
  });

  await audit({
    action: 'waitlist.removed',
    entityType: 'WaitlistEntry',
    entityId: entry.id,
    actorAccountId: actor.accountId,
    context,
  });

  return noContent();
});
