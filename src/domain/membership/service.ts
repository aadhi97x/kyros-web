/**
 * Membership lifecycle — applying the policy verdicts.
 *
 * `policy.ts` decides what should happen; this module makes it happen. Keeping
 * them apart means every branch of "what should happen" is tested without a
 * database, and this file only has to get the writes right.
 */

import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { audit, type AuditContext } from '@/lib/audit';
import { parseClubConfig } from '../config/engine';
import { creditWallet } from '../money/payments';
import { releaseBatchPlace } from '../enrollment/service';
import {
  evaluateCancellation,
  evaluatePause,
  evaluateTierChange,
  isRefusal,
  type PauseReason,
} from './policy';

/** Billing period for a membership, derived from its start date and package. */
function currentPeriod(membership: {
  startDate: Date | null;
  createdAt: Date;
  package: { billingType: string; termMonths: number | null };
}): { start: Date; end: Date } {
  const start = membership.startDate ?? membership.createdAt;
  const end = new Date(start);

  switch (membership.package.billingType) {
    case 'TERM':
      end.setMonth(end.getMonth() + (membership.package.termMonths ?? 3));
      break;
    case 'MONTHLY':
    default:
      end.setMonth(end.getMonth() + 1);
      break;
  }

  return { start, end };
}

async function loadMembership(membershipId: string) {
  const membership = await prisma.membership.findUnique({
    where: { id: membershipId },
    include: {
      package: { select: { id: true, pricePaise: true, registrationFeePaise: true, billingType: true, termMonths: true, tierName: true } },
      addOnLines: { select: { pricePaise: true } },
      batch: { select: { id: true, clubId: true, club: { select: { config: true } } } },
      playerProfile: { select: { id: true, accountId: true, fullName: true } },
      pauses: { select: { startDate: true, endDate: true } },
    },
  });

  if (!membership) throw ApiError.notFound('Membership');
  return membership;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pause days already used in the last 12 months. */
function daysPausedThisYear(pauses: Array<{ startDate: Date; endDate: Date }>): number {
  const cutoff = new Date(Date.now() - 365 * DAY_MS);
  return pauses
    .filter((pause) => pause.endDate.getTime() >= cutoff.getTime())
    .reduce(
      (total, pause) =>
        total + Math.round((pause.endDate.getTime() - pause.startDate.getTime()) / DAY_MS),
      0,
    );
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

export async function pauseMembership(params: {
  membershipId: string;
  actorAccountId: string;
  reason: PauseReason;
  reasonNote?: string;
  startDate: Date;
  endDate: Date;
  hasProof?: boolean;
  context?: AuditContext;
}) {
  const membership = await loadMembership(params.membershipId);
  const config = parseClubConfig(membership.batch.club.config);
  const period = currentPeriod(membership);

  const verdict = evaluatePause({
    config,
    state: {
      status: membership.status,
      daysPausedThisYear: daysPausedThisYear(membership.pauses),
      periodStart: period.start,
      periodEnd: period.end,
      periodAmountPaise: membership.package.pricePaise,
    },
    request: {
      reason: params.reason,
      startDate: params.startDate,
      endDate: params.endDate,
      requestedOn: new Date(),
      hasProof: params.hasProof ?? false,
    },
  });

  if (isRefusal(verdict)) {
    throw ApiError.policyViolation(verdict.reason, { code: verdict.code, ...verdict.details });
  }

  await prisma.$transaction(async (tx) => {
    await tx.membershipPause.create({
      data: {
        membershipId: membership.id,
        reason: params.reason,
        reasonNote: params.reasonNote,
        startDate: params.startDate,
        endDate: params.endDate,
        carryoverAppliedPaise: verdict.carryoverPaise,
        // Snapshot the policy so a later edit to the club's rules does not
        // rewrite what this member was told at the time.
        policySnapshot: JSON.parse(JSON.stringify(config.pause)),
      },
    });

    await tx.membership.update({
      where: { id: membership.id },
      data: {
        status: 'PAUSED',
        endDate:
          verdict.extendPeriodByDays > 0
            ? new Date(period.end.getTime() + verdict.extendPeriodByDays * DAY_MS)
            : membership.endDate,
      },
    });
  });

  // Wallet credit runs outside the pause transaction so its own ledger write
  // and balance update stay atomic together.
  if (verdict.carryoverPaise > 0) {
    await creditWallet({
      accountId: membership.playerProfile.accountId,
      amountPaise: verdict.carryoverPaise,
      reason: 'pause_carryover',
      description: `Pause credit for ${membership.playerProfile.fullName}`,
      membershipId: membership.id,
      actorAccountId: params.actorAccountId,
      context: params.context,
    });
  }

  await audit({
    action: 'membership.paused',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: params.actorAccountId,
    metadata: {
      reason: params.reason,
      pauseDays: verdict.pauseDays,
      outcome: verdict.outcome,
      carryoverPaise: verdict.carryoverPaise,
    },
    context: params.context,
  });

  return verdict;
}

export async function resumeMembership(params: {
  membershipId: string;
  actorAccountId: string;
  context?: AuditContext;
}) {
  const membership = await loadMembership(params.membershipId);
  if (membership.status !== 'PAUSED') {
    throw ApiError.conflict('That membership is not paused.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: membership.id }, data: { status: 'ACTIVE' } });
    await tx.membershipPause.updateMany({
      where: { membershipId: membership.id, resumedAt: null },
      data: { resumedAt: new Date() },
    });
  });

  await audit({
    action: 'membership.resumed',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: params.actorAccountId,
    context: params.context,
  });

  return { status: 'ACTIVE' as const };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelMembership(params: {
  membershipId: string;
  actorAccountId: string;
  reason?: string;
  context?: AuditContext;
}) {
  const membership = await loadMembership(params.membershipId);
  const config = parseClubConfig(membership.batch.club.config);
  const period = currentPeriod(membership);

  const sessionsAttended = await prisma.attendance.count({
    where: {
      playerProfileId: membership.playerProfileId,
      status: { in: ['PRESENT', 'LATE'] },
      session: { batchId: membership.batchId },
    },
  });

  const verdict = evaluateCancellation({
    config,
    state: {
      status: membership.status,
      periodStart: period.start,
      periodEnd: period.end,
      periodAmountPaise: membership.package.pricePaise,
      registrationFeePaise: membership.package.registrationFeePaise,
      addOnsPaise: membership.addOnLines.reduce((sum, line) => sum + line.pricePaise, 0),
      sessionsAttended,
      membershipStartDate: period.start,
    },
    request: { requestedOn: new Date(), reason: params.reason },
  });

  if (isRefusal(verdict)) {
    throw ApiError.policyViolation(verdict.reason, { code: verdict.code });
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: membership.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationEffectiveAt: verdict.effectiveDate,
        cancellationReason: params.reason,
      },
    });
    // Hand the place back so the waitlist can move.
    await releaseBatchPlace(tx, membership.batchId);
  });

  if (verdict.creditPaise > 0) {
    await creditWallet({
      accountId: membership.playerProfile.accountId,
      amountPaise: verdict.creditPaise,
      reason: 'refund',
      description: `Cancellation credit for ${membership.playerProfile.fullName}`,
      membershipId: membership.id,
      actorAccountId: params.actorAccountId,
      context: params.context,
    });
  }

  // A refund is recorded as a negative payment so the ledger stays complete;
  // moving the money is the gateway's job and runs from a separate worker.
  if (verdict.refundPaise > 0) {
    await prisma.payment.create({
      data: {
        accountId: membership.playerProfile.accountId,
        membershipId: membership.id,
        type: 'REFUND',
        status: 'CREATED',
        amountPaise: verdict.refundPaise,
        idempotencyKey: `refund:${membership.id}`,
      },
    });
  }

  await audit({
    action: 'membership.cancelled',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: params.actorAccountId,
    metadata: {
      basis: verdict.basis,
      refundPaise: verdict.refundPaise,
      creditPaise: verdict.creditPaise,
      effectiveDate: verdict.effectiveDate.toISOString(),
    },
    context: params.context,
  });

  // Notify the first person waiting, if anyone is.
  const nextInQueue = await prisma.waitlistEntry.findFirst({
    where: { batchId: membership.batchId, removedAt: null, promotedAt: null },
    orderBy: { position: 'asc' },
    select: { id: true },
  });

  return { verdict, waitlistEntryToPromote: nextInQueue?.id ?? null };
}

// ---------------------------------------------------------------------------
// Upgrade / downgrade
// ---------------------------------------------------------------------------

export async function changeTier(params: {
  membershipId: string;
  targetPackageId: string;
  actorAccountId: string;
  context?: AuditContext;
}) {
  const membership = await loadMembership(params.membershipId);
  const config = parseClubConfig(membership.batch.club.config);
  const period = currentPeriod(membership);

  const target = await prisma.package.findUnique({
    where: { id: params.targetPackageId },
    select: { id: true, clubId: true, pricePaise: true, tierName: true, batchId: true, isActive: true },
  });

  if (!target || !target.isActive) throw ApiError.notFound('Package');
  if (target.clubId !== membership.batch.clubId) {
    throw ApiError.badRequest('That package belongs to a different club.');
  }

  const verdict = evaluateTierChange({
    config,
    currentPricePaise: membership.package.pricePaise,
    targetPricePaise: target.pricePaise,
    periodStart: period.start,
    periodEnd: period.end,
    changeOn: new Date(),
    status: membership.status,
  });

  if (isRefusal(verdict)) {
    throw ApiError.policyViolation(verdict.reason, { code: verdict.code });
  }

  // An upgrade is only applied once the difference is paid, so the caller gets
  // the amount due and comes back through the payment flow.
  if (verdict.amountDuePaise > 0) {
    return { verdict, applied: false, targetPackageId: target.id };
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: {
      packageId: target.id,
      ...(target.batchId ? { batchId: target.batchId } : {}),
    },
  });

  if (verdict.creditDuePaise > 0) {
    await creditWallet({
      accountId: membership.playerProfile.accountId,
      amountPaise: verdict.creditDuePaise,
      reason: 'downgrade_credit',
      description: `Downgrade from ${membership.package.tierName} to ${target.tierName}`,
      membershipId: membership.id,
      actorAccountId: params.actorAccountId,
      context: params.context,
    });
  }

  await audit({
    action: 'membership.upgraded',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: params.actorAccountId,
    metadata: {
      direction: verdict.direction,
      fromPackageId: membership.package.id,
      toPackageId: target.id,
      creditPaise: verdict.creditDuePaise,
    },
    context: params.context,
  });

  return { verdict, applied: true, targetPackageId: target.id };
}

// ---------------------------------------------------------------------------
// Member-facing list
// ---------------------------------------------------------------------------

/**
 * Spec 2.9: the "My memberships" screen — every player profile on the account
 * and their memberships with status badges. Spec 2.8: one combined billing view
 * per account, so the wallet is returned alongside rather than per child.
 */
export async function myMemberships(accountId: string) {
  const [profiles, account] = await Promise.all([
    prisma.playerProfile.findMany({
      where: { accountId, status: 'ACTIVE' },
      include: {
        memberships: {
          orderBy: { createdAt: 'desc' },
          include: {
            package: { select: { id: true, tierName: true, pricePaise: true, billingType: true } },
            batch: {
              select: {
                id: true,
                name: true,
                mode: true,
                club: { select: { id: true, name: true, logoUrl: true, config: true } },
                centre: { select: { id: true, name: true, city: true } },
              },
            },
            instalments: { orderBy: { sequence: 'asc' } },
            pauses: { orderBy: { startDate: 'desc' } },
          },
        },
      },
    }),
    prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { walletBalancePaise: true },
    }),
  ]);

  return {
    walletBalancePaise: account.walletBalancePaise,
    players: profiles.map((profile) => ({
      id: profile.id,
      fullName: profile.fullName,
      photoUrl: profile.photoUrl,
      memberships: profile.memberships.map((membership) => {
        const config = parseClubConfig(membership.batch.club.config);
        return {
          id: membership.id,
          status: membership.status,
          startDate: membership.startDate,
          endDate: membership.endDate,
          totalPaise: membership.totalPaise,
          paidPaise: membership.paidPaise,
          outstandingPaise: Math.max(0, membership.totalPaise - membership.paidPaise),
          isPartPayment: membership.isPartPayment,
          creditsRemaining: membership.creditsRemaining,
          package: membership.package,
          batch: {
            id: membership.batch.id,
            name: membership.batch.name,
            mode: membership.batch.mode,
            centre: membership.batch.centre,
          },
          club: {
            id: membership.batch.club.id,
            name: membership.batch.club.name,
            logoUrl: membership.batch.club.logoUrl,
          },
          instalments: membership.instalments,
          pauseHistory: membership.pauses,
          // Spec 2.9: "the app shows the carryover rules that club has set".
          policies: {
            pauseAllowed: config.pause.allowed,
            pauseMinDays: config.pause.minDays,
            pauseMaxDaysPerYear: config.pause.maxDaysPerYear,
            pauseNoticeDays: config.pause.noticeDays,
            pauseAcceptedReasons: config.pause.acceptedReasons,
            carryover: config.refunds.carryover,
            cancellationNoticeDays: config.refunds.cancellationNoticeDays,
            refundIfNeverAttended: config.refunds.refundIfNeverAttended,
          },
        };
      }),
    })),
  };
}
