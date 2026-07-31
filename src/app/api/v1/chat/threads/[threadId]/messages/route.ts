import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody, parsePagination } from '@/lib/api/handler';
import { assertThreadParticipant } from '@/lib/auth/rbac';
import { parseClubConfig } from '@/domain/config/engine';

type Params = { threadId: string };

/** GET /api/v1/chat/threads/:threadId/messages */
export const GET = authedRoute<Params>(async ({ request, params, actor }) => {
  await assertThreadParticipant(actor, params.threadId);
  const { page, perPage } = parsePagination(request, 100);

  const messages = await prisma.chatMessage.findMany({
    where: { threadId: params.threadId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * perPage,
    take: perPage,
    include: { senderAccount: { select: { id: true, name: true } } },
  });

  // Reading the thread marks it read, so the badge clears without a second call.
  await prisma.chatParticipant.update({
    where: { threadId_accountId: { threadId: params.threadId, accountId: actor.accountId } },
    data: { lastReadAt: new Date() },
  });

  return ok(messages.reverse());
});

const sendSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  attachmentUrl: z.string().url().max(500).optional(),
  /** Lets the client retry a send without posting twice. */
  clientMutationId: z.string().min(8).max(64).optional(),
});

/**
 * POST /api/v1/chat/threads/:threadId/messages
 *
 * Spec 2.12 / 3.2: chat can be switched off per club, and members can be
 * restricted to posting inside set hours. Both are enforced here — coaches and
 * owners are exempt from the hours, since a schedule change at 10pm is exactly
 * when the club needs to reach everyone.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, sendSchema);
  await assertThreadParticipant(actor, params.threadId);

  const thread = await prisma.chatThread.findUniqueOrThrow({
    where: { id: params.threadId },
    select: { id: true, isActive: true, type: true, club: { select: { id: true, config: true } } },
  });

  if (!thread.isActive) throw ApiError.conflict('This conversation is closed.');

  const config = parseClubConfig(thread.club.config);
  if (!config.communication.chatEnabled) {
    throw ApiError.forbidden('This club has switched chat off.');
  }
  if (thread.type === 'BATCH_GROUP' && !config.communication.batchChatEnabled) {
    throw ApiError.forbidden('This club has switched batch chat off.');
  }
  if (thread.type === 'DIRECT' && !config.communication.directChatEnabled) {
    throw ApiError.forbidden('This club has switched direct messages off.');
  }

  const isStaff =
    actor.ownedClubIds.includes(thread.club.id) || actor.coachedClubIds.includes(thread.club.id);

  if (!isStaff) {
    const now = new Date();
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const { startMinute, endMinute } = config.communication.memberPostingHours;
    if (minuteOfDay < startMinute || minuteOfDay > endMinute) {
      throw ApiError.forbidden('This club limits when members can post in the group chat.');
    }
  }

  if (body.clientMutationId) {
    const duplicate = await prisma.chatMessage.findUnique({
      where: { clientMutationId: body.clientMutationId },
      include: { senderAccount: { select: { id: true, name: true } } },
    });
    if (duplicate) return created(duplicate);
  }

  const message = await prisma.chatMessage.create({
    data: {
      threadId: params.threadId,
      senderAccountId: actor.accountId,
      body: body.body,
      attachmentUrl: body.attachmentUrl,
      clientMutationId: body.clientMutationId,
    },
    include: { senderAccount: { select: { id: true, name: true } } },
  });

  return created(message);
});
