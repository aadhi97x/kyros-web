import { z } from 'zod';
import { prisma } from '@/lib/db';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { createPaymentIntent } from '@/domain/money/payments';
import { auditContextFrom } from '@/lib/audit';

const bodySchema = z.object({
  type: z.enum(['MEMBERSHIP_FEE', 'INSTALMENT', 'CREDIT_PACK', 'TURF_BOOKING', 'WALLET_TOPUP']),
  amountPaise: z.number().int().min(0),
  membershipId: z.string().optional(),
  instalmentId: z.string().optional(),
  bookingId: z.string().optional(),
  /**
   * Spec 2.8 / 8: idempotency. The client should send a stable key and reuse it
   * verbatim on every retry; when it does not, one is derived from the target.
   */
  idempotencyKey: z.string().min(8).max(80).optional(),
});

/**
 * POST /api/v1/payments
 *
 * Creates (or re-returns) a payment intent. A retry with the same key never
 * charges twice — `deduplicated: true` in the response means an existing
 * payment was handed back.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  const intent = await createPaymentIntent({
    accountId: actor.accountId,
    ...body,
    context,
  });

  return created(intent);
});

/**
 * GET /api/v1/payments
 *
 * Spec 2.8: one payment history for the whole account, with downloadable
 * receipts — never one list per child.
 */
export const GET = authedRoute(async ({ actor }) => {
  const payments = await prisma.payment.findMany({
    where: { accountId: actor.accountId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      type: true,
      status: true,
      method: true,
      amountPaise: true,
      currency: true,
      paidAt: true,
      createdAt: true,
      membership: {
        select: {
          id: true,
          playerProfile: { select: { id: true, fullName: true } },
          batch: { select: { name: true, club: { select: { name: true } } } },
        },
      },
    },
  });

  const wallet = await prisma.walletEntry.findMany({
    where: { accountId: actor.accountId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return ok({
    payments: payments.map((payment) => ({
      ...payment,
      // Spec 2.11: tag each line with the player it concerns.
      forPlayer: payment.membership?.playerProfile ?? null,
      receiptUrl: payment.status === 'SUCCEEDED' ? `/api/v1/payments/${payment.id}/receipt` : null,
    })),
    walletEntries: wallet,
  });
});
