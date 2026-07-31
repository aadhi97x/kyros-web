import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';

/** GET /api/v1/accounts/me */
export const GET = authedRoute(async ({ actor }) => {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: actor.accountId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      type: true,
      walletBalancePaise: true,
      hasConsentOnFile: true,
      createdAt: true,
    },
  });
  return ok(account);
});

const patchSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().email().max(200).optional(),
  /** Spec 2.1: parent vs adult player, chosen right after verification. */
  type: z.enum(['GUARDIAN', 'ADULT_PLAYER']).optional(),
});

/** PATCH /api/v1/accounts/me */
export const PATCH = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, patchSchema);

  const account = await prisma.account.update({
    where: { id: actor.accountId },
    data: body,
    select: { id: true, name: true, email: true, phone: true, role: true, type: true },
  });

  return ok(account);
});
