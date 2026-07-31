import { z } from 'zod';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { failPayment, settlePayment } from '@/domain/money/payments';
import { auditContextFrom } from '@/lib/audit';

type Params = { paymentId: string };

const bodySchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('SUCCEEDED'),
    gatewayPaymentId: z.string().min(1),
    method: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH', 'BANK_TRANSFER']).optional(),
  }),
  z.object({
    outcome: z.literal('FAILED'),
    reason: z.string().max(500).default('Payment was not completed.'),
  }),
]);

/**
 * POST /api/v1/payments/:paymentId/settle
 *
 * Client-side confirmation after the gateway checkout closes. The authoritative
 * settlement is the signed webhook; this exists so the app can move on without
 * waiting for it. Both paths are idempotent, so whichever arrives second is a
 * no-op — `alreadySettled: true`.
 */
export const POST = authedRoute<Params>(async ({ request, params }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  if (body.outcome === 'FAILED') {
    await failPayment({
      paymentId: params.paymentId,
      reason: body.reason,
      // Give the batch place back so an abandoned checkout does not
      // permanently shrink the batch.
      releaseHold: true,
      context,
    });
    return ok({ status: 'FAILED' });
  }

  const result = await settlePayment({
    paymentId: params.paymentId,
    gatewayPaymentId: body.gatewayPaymentId,
    method: body.method,
    context,
  });

  return ok(result);
});
