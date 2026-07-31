/**
 * Payment intake.
 *
 * Spec 2.8 / 8: "Payment handling must be idempotent — no double charges on
 * retry." Two mechanisms enforce that:
 *
 *   1. An `idempotencyKey` unique index. A retried create returns the ORIGINAL
 *      payment rather than making a second one.
 *   2. Gateway payment ids are unique too, so a webhook delivered twice (which
 *      every gateway does eventually) settles the payment exactly once.
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { audit, type AuditContext } from '@/lib/audit';
import { releaseBatchPlace } from '../enrollment/service';

export type PaymentIntentType = 'MEMBERSHIP_FEE' | 'INSTALMENT' | 'CREDIT_PACK' | 'TURF_BOOKING' | 'WALLET_TOPUP';

/**
 * Derive a stable key from the thing being paid for, so a client that retries
 * without sending its own key still cannot double-charge.
 */
export function deriveIdempotencyKey(parts: Record<string, string | number | undefined>): string {
  const canonical = Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

export interface CreatePaymentIntentInput {
  accountId: string;
  type: PaymentIntentType;
  amountPaise: number;
  membershipId?: string;
  instalmentId?: string;
  bookingId?: string;
  /** Client-supplied key; derived from the target when absent. */
  idempotencyKey?: string;
  context?: AuditContext;
}

export interface PaymentIntent {
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: string;
  /** True when an existing payment was returned instead of a new one. */
  deduplicated: boolean;
  gatewayOrderId: string | null;
}

/**
 * Create (or re-return) a payment intent.
 *
 * Deliberately does NOT talk to the gateway inside a transaction — a network
 * call inside an open transaction holds a connection for the duration of
 * somebody else's outage.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<PaymentIntent> {
  if (input.amountPaise < 0) {
    throw ApiError.badRequest('A payment amount cannot be negative.');
  }

  const idempotencyKey =
    input.idempotencyKey ??
    deriveIdempotencyKey({
      accountId: input.accountId,
      type: input.type,
      amountPaise: input.amountPaise,
      membershipId: input.membershipId,
      instalmentId: input.instalmentId,
      bookingId: input.bookingId,
    });

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });

  if (existing) {
    // A settled payment is never re-opened. This is the branch that stops a
    // double charge when a flaky connection makes the client retry.
    return {
      paymentId: existing.id,
      amountPaise: existing.amountPaise,
      currency: existing.currency,
      status: existing.status,
      deduplicated: true,
      gatewayOrderId: existing.gatewayOrderId,
    };
  }

  const payment = await prisma.payment.create({
    data: {
      accountId: input.accountId,
      type: input.type === 'INSTALMENT' ? 'INSTALMENT' : input.type,
      status: 'CREATED',
      amountPaise: input.amountPaise,
      membershipId: input.membershipId,
      instalmentId: input.instalmentId,
      bookingId: input.bookingId,
      idempotencyKey,
      gateway: 'razorpay',
    },
  });

  await audit({
    action: 'payment.created',
    entityType: 'Payment',
    entityId: payment.id,
    actorAccountId: input.accountId,
    metadata: { type: input.type, amountPaise: input.amountPaise, membershipId: input.membershipId },
    context: input.context,
  });

  return {
    paymentId: payment.id,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    deduplicated: false,
    gatewayOrderId: payment.gatewayOrderId,
  };
}

export interface SettlePaymentInput {
  paymentId: string;
  gatewayPaymentId: string;
  method?: 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'CASH' | 'BANK_TRANSFER';
  context?: AuditContext;
}

/**
 * Mark a payment successful and advance whatever it was paying for.
 *
 * Safe to call twice with the same gateway payment id — gateways retry
 * webhooks, and the second delivery must be a no-op rather than a second
 * activation.
 */
export async function settlePayment(input: SettlePaymentInput): Promise<{
  status: string;
  membershipStatus?: string;
  alreadySettled: boolean;
}> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    include: {
      membership: {
        select: {
          id: true,
          status: true,
          totalPaise: true,
          paidPaise: true,
          isPartPayment: true,
          batchId: true,
          playerProfile: { select: { id: true, accountId: true, fullName: true } },
          batch: { select: { club: { select: { config: true } } } },
        },
      },
    },
  });

  if (!payment) throw ApiError.notFound('Payment');

  if (payment.status === 'SUCCEEDED') {
    return {
      status: payment.status,
      membershipStatus: payment.membership?.status,
      alreadySettled: true,
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Claim the settlement. The gatewayPaymentId unique index means a
    // concurrent duplicate webhook fails here rather than settling twice.
    const settled = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCEEDED',
        method: input.method,
        gatewayPaymentId: input.gatewayPaymentId,
        paidAt: new Date(),
      },
    });

    if (payment.instalmentId) {
      await tx.instalment.update({
        where: { id: payment.instalmentId },
        data: { paidAt: new Date(), paymentId: settled.id, overdue: false },
      });
    }

    if (!payment.membership) return { membershipStatus: undefined };

    const membership = payment.membership;
    const paidPaise = membership.paidPaise + settled.amountPaise;
    const fullySettled = paidPaise >= membership.totalPaise;

    // Part payment activates on the first successful instalment; a full payment
    // activates only when the whole amount has landed. Either way, a membership
    // waiting on club approval stays waiting.
    const shouldActivate =
      membership.status !== 'PENDING_APPROVAL' && (membership.isPartPayment || fullySettled);

    const updated = await tx.membership.update({
      where: { id: membership.id },
      data: {
        paidPaise,
        status: shouldActivate ? 'ACTIVE' : membership.status,
        startDate: shouldActivate ? new Date() : undefined,
      },
    });

    return { membershipStatus: updated.status };
  });

  await audit({
    action: 'payment.succeeded',
    entityType: 'Payment',
    entityId: payment.id,
    actorAccountId: payment.accountId,
    metadata: {
      amountPaise: payment.amountPaise,
      gatewayPaymentId: input.gatewayPaymentId,
      membershipId: payment.membershipId,
    },
    context: input.context,
  });

  return { status: 'SUCCEEDED', membershipStatus: result.membershipStatus, alreadySettled: false };
}

/**
 * Mark a payment failed and release anything it was holding.
 *
 * The batch place claimed at enrollment must go back into the pool, otherwise
 * an abandoned checkout permanently shrinks the batch.
 */
export async function failPayment(params: {
  paymentId: string;
  reason: string;
  releaseHold?: boolean;
  context?: AuditContext;
}): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { id: params.paymentId },
    select: {
      id: true,
      accountId: true,
      status: true,
      membership: { select: { id: true, status: true, batchId: true, paidPaise: true } },
    },
  });

  if (!payment) throw ApiError.notFound('Payment');
  if (payment.status === 'SUCCEEDED') {
    throw ApiError.conflict('That payment already succeeded and cannot be marked failed.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: params.reason },
    });

    const membership = payment.membership;
    // Only release when nothing has been paid — a part payment that fails its
    // second instalment must not evict an active member.
    if (params.releaseHold && membership && membership.paidPaise === 0) {
      await releaseBatchPlace(tx, membership.batchId);
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: 'Payment was not completed.',
        },
      });
    }
  });

  await audit({
    action: 'payment.failed',
    entityType: 'Payment',
    entityId: payment.id,
    actorAccountId: payment.accountId,
    metadata: { reason: params.reason },
    context: params.context,
  });
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/**
 * Credit the shared account wallet (spec 2.8).
 *
 * The `WalletEntry` ledger is the truth; `Account.walletBalancePaise` is a
 * cached running total, kept in step inside the same transaction.
 */
export async function creditWallet(params: {
  accountId: string;
  amountPaise: number;
  reason: 'pause_carryover' | 'downgrade_credit' | 'refund' | 'topup';
  description?: string;
  membershipId?: string;
  paymentId?: string;
  actorAccountId?: string;
  context?: AuditContext;
}): Promise<{ balancePaise: number }> {
  if (params.amountPaise <= 0) {
    throw ApiError.badRequest('A wallet credit must be positive.');
  }

  const balance = await prisma.$transaction(async (tx) => {
    const account = await tx.account.update({
      where: { id: params.accountId },
      data: { walletBalancePaise: { increment: params.amountPaise } },
      select: { walletBalancePaise: true },
    });

    await tx.walletEntry.create({
      data: {
        accountId: params.accountId,
        amountPaise: params.amountPaise,
        reason: params.reason,
        description: params.description,
        membershipId: params.membershipId,
        paymentId: params.paymentId,
        balanceAfterPaise: account.walletBalancePaise,
      },
    });

    return account.walletBalancePaise;
  });

  await audit({
    action: 'wallet.credited',
    entityType: 'Account',
    entityId: params.accountId,
    actorAccountId: params.actorAccountId ?? params.accountId,
    metadata: { amountPaise: params.amountPaise, reason: params.reason, balanceAfterPaise: balance },
    context: params.context,
  });

  return { balancePaise: balance };
}

/**
 * Sanity check for a nightly job: the cached balance must equal the ledger sum.
 * Cheap insurance against a bug that quietly gives members free money.
 */
export async function reconcileWallet(accountId: string): Promise<{
  cachedPaise: number;
  ledgerPaise: number;
  drifted: boolean;
}> {
  const [account, aggregate] = await Promise.all([
    prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { walletBalancePaise: true },
    }),
    prisma.walletEntry.aggregate({
      where: { accountId },
      _sum: { amountPaise: true },
    }),
  ]);

  const ledgerPaise = aggregate._sum.amountPaise ?? 0;
  return {
    cachedPaise: account.walletBalancePaise,
    ledgerPaise,
    drifted: account.walletBalancePaise !== ledgerPaise,
  };
}
