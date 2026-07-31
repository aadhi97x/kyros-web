import { prisma } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { authedRoute } from '@/lib/api/handler';
import { parseClubConfigSafe } from '@/domain/config/engine';

/**
 * GET /api/v1/chat/threads
 *
 * Spec 2.12: a group chat per batch, plus one-to-one where the club enables it.
 * A club that has switched chat off entirely disappears from this list — the
 * config is re-checked here rather than trusted from thread creation time, so
 * flipping the toggle takes effect immediately.
 */
export const GET = authedRoute(async ({ actor }) => {
  const participations = await prisma.chatParticipant.findMany({
    where: { accountId: actor.accountId },
    include: {
      thread: {
        include: {
          club: { select: { id: true, name: true, logoUrl: true, config: true } },
          batch: { select: { id: true, name: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              body: true,
              createdAt: true,
              senderAccount: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  const threads = await Promise.all(
    participations
      .filter((participation) => participation.thread.isActive)
      .filter((participation) => {
        const { config } = parseClubConfigSafe(participation.thread.club.config);
        if (!config.communication.chatEnabled) return false;
        if (participation.thread.type === 'BATCH_GROUP') return config.communication.batchChatEnabled;
        return config.communication.directChatEnabled;
      })
      .map(async (participation) => {
        const unreadCount = await prisma.chatMessage.count({
          where: {
            threadId: participation.threadId,
            deletedAt: null,
            ...(participation.lastReadAt ? { createdAt: { gt: participation.lastReadAt } } : {}),
            senderAccountId: { not: actor.accountId },
          },
        });

        return {
          id: participation.thread.id,
          type: participation.thread.type,
          title: participation.thread.title,
          club: {
            id: participation.thread.club.id,
            name: participation.thread.club.name,
            logoUrl: participation.thread.club.logoUrl,
          },
          batch: participation.thread.batch,
          myRole: participation.role,
          muted: participation.mutedAt !== null,
          unreadCount,
          lastMessage: participation.thread.messages[0] ?? null,
        };
      }),
  );

  threads.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt.getTime() ?? 0;
    const bTime = b.lastMessage?.createdAt.getTime() ?? 0;
    return bTime - aTime;
  });

  return ok(threads);
});
