/**
 * Membership lifecycle policy.
 *
 * Spec 2.9 / 7: "Refund, carryover-vs-adjust-to-next-month, and refund-if-
 * never-attended all follow the club's policy settings — the platform enforces
 * whatever the club configured."
 *
 * This module decides WHAT should happen. It does not touch the database; the
 * service layer applies its verdict. That split means every policy branch is
 * unit-testable without a Postgres instance.
 *
 * Pure module: no I/O.
 */

import type { ClubConfig } from '../config/schema';
import { prorateUnused } from '../money/pricing';

export type PauseReason = 'INJURY' | 'ILLNESS' | 'TRAVEL' | 'OTHER';

export interface PolicyRefusal {
  allowed: false;
  code:
    | 'PAUSE_NOT_ALLOWED'
    | 'PAUSE_TOO_SHORT'
    | 'PAUSE_ALLOWANCE_EXCEEDED'
    | 'PAUSE_NOTICE_TOO_SHORT'
    | 'PAUSE_REASON_NOT_ACCEPTED'
    | 'PAUSE_PROOF_REQUIRED'
    | 'PAUSE_DATES_INVALID'
    | 'MEMBERSHIP_NOT_ACTIVE'
    | 'CANCELLATION_TOO_SOON'
    | 'DOWNGRADE_NOT_PERMITTED';
  reason: string;
  /** Extra context for the UI, e.g. how many days are left in the allowance. */
  details?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

export interface PauseRequest {
  reason: PauseReason;
  startDate: Date;
  endDate: Date;
  requestedOn: Date;
  hasProof: boolean;
}

export interface PauseState {
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'WAITLISTED' | 'PENDING_PAYMENT' | 'PENDING_APPROVAL' | 'EXPIRED';
  /** Pause days already used in the current membership year. */
  daysPausedThisYear: number;
  /** Current billing period, used to work out what the pause is worth. */
  periodStart: Date;
  periodEnd: Date;
  periodAmountPaise: number;
}

export interface PauseApproval {
  allowed: true;
  pauseDays: number;
  /** What the pause produces, per the club's carryover policy. */
  outcome: 'CARRYOVER_CREDIT' | 'ADJUST_NEXT_MONTH' | 'NEITHER';
  /** Credit to the account wallet, in paise. Zero unless outcome is credit. */
  carryoverPaise: number;
  /** Days to push the period end back by. Zero unless outcome is adjustment. */
  extendPeriodByDays: number;
  /** Human-readable statement of what the member gets, for the confirm screen. */
  summary: string;
}

export type PauseVerdict = PauseApproval | PolicyRefusal;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Spec 2.9: "Pause (injury or illness): reason, date range, and the app shows
 * the carryover rules that club has set."
 */
export function evaluatePause(params: {
  config: ClubConfig;
  state: PauseState;
  request: PauseRequest;
}): PauseVerdict {
  const { config, state, request } = params;
  const policy = config.pause;

  if (state.status !== 'ACTIVE') {
    return {
      allowed: false,
      code: 'MEMBERSHIP_NOT_ACTIVE',
      reason: `Only an active membership can be paused. This one is ${state.status.toLowerCase().replace('_', ' ')}.`,
    };
  }

  if (!policy.allowed) {
    return {
      allowed: false,
      code: 'PAUSE_NOT_ALLOWED',
      reason: 'This club does not allow memberships to be paused.',
    };
  }

  if (request.endDate.getTime() <= request.startDate.getTime()) {
    return {
      allowed: false,
      code: 'PAUSE_DATES_INVALID',
      reason: 'The pause end date must be after the start date.',
    };
  }

  if (!policy.acceptedReasons.includes(request.reason)) {
    return {
      allowed: false,
      code: 'PAUSE_REASON_NOT_ACCEPTED',
      reason: `This club accepts pauses for: ${policy.acceptedReasons.join(', ').toLowerCase()}.`,
      details: { accepted: policy.acceptedReasons.join(',') },
    };
  }

  const noticeDays = daysBetween(request.requestedOn, request.startDate);
  if (noticeDays < policy.noticeDays) {
    return {
      allowed: false,
      code: 'PAUSE_NOTICE_TOO_SHORT',
      reason: `This club needs ${policy.noticeDays} days' notice for a pause. You gave ${Math.max(0, noticeDays)}.`,
      details: { requiredNoticeDays: policy.noticeDays, givenNoticeDays: Math.max(0, noticeDays) },
    };
  }

  const pauseDays = daysBetween(request.startDate, request.endDate);

  if (pauseDays < policy.minDays) {
    return {
      allowed: false,
      code: 'PAUSE_TOO_SHORT',
      reason: `The shortest pause this club allows is ${policy.minDays} days.`,
      details: { minDays: policy.minDays, requestedDays: pauseDays },
    };
  }

  const remainingAllowance = policy.maxDaysPerYear - state.daysPausedThisYear;
  if (pauseDays > remainingAllowance) {
    return {
      allowed: false,
      code: 'PAUSE_ALLOWANCE_EXCEEDED',
      reason:
        remainingAllowance <= 0
          ? `You have used your full ${policy.maxDaysPerYear}-day pause allowance for this year.`
          : `That would exceed your pause allowance — ${remainingAllowance} of ${policy.maxDaysPerYear} days left this year.`,
      details: {
        maxDaysPerYear: policy.maxDaysPerYear,
        usedDays: state.daysPausedThisYear,
        remainingDays: Math.max(0, remainingAllowance),
        requestedDays: pauseDays,
      },
    };
  }

  if (policy.proofRequiredAboveDays > 0 && pauseDays > policy.proofRequiredAboveDays && !request.hasProof) {
    return {
      allowed: false,
      code: 'PAUSE_PROOF_REQUIRED',
      reason: `Pauses longer than ${policy.proofRequiredAboveDays} days need supporting documentation.`,
      details: { proofRequiredAboveDays: policy.proofRequiredAboveDays },
    };
  }

  // Approved. Work out what it is worth under the club's carryover policy.
  const { unusedPaise } = prorateUnused({
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
    asOf: request.startDate,
    periodAmountPaise: state.periodAmountPaise,
  });

  // The pause can be shorter than the remaining period, so cap the value at the
  // pause's own worth rather than the whole remainder.
  const periodDays = Math.max(1, daysBetween(state.periodStart, state.periodEnd));
  const pauseValuePaise = Math.min(
    unusedPaise,
    Math.floor((state.periodAmountPaise * pauseDays) / periodDays),
  );

  switch (config.refunds.carryover) {
    case 'CARRYOVER_CREDIT':
      return {
        allowed: true,
        pauseDays,
        outcome: 'CARRYOVER_CREDIT',
        carryoverPaise: pauseValuePaise,
        extendPeriodByDays: 0,
        summary: `Your membership pauses for ${pauseDays} days. The unused value is added to your account wallet and can be used for any player on your account.`,
      };

    case 'ADJUST_NEXT_MONTH':
      return {
        allowed: true,
        pauseDays,
        outcome: 'ADJUST_NEXT_MONTH',
        carryoverPaise: 0,
        extendPeriodByDays: pauseDays,
        summary: `Your membership pauses for ${pauseDays} days and your next billing date moves back by the same ${pauseDays} days.`,
      };

    case 'NEITHER':
      return {
        allowed: true,
        pauseDays,
        outcome: 'NEITHER',
        carryoverPaise: 0,
        extendPeriodByDays: 0,
        summary: `Your membership pauses for ${pauseDays} days. This club does not carry unused time over, so the paid period continues to run.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export interface CancellationRequest {
  requestedOn: Date;
  reason?: string;
}

export interface CancellationState {
  status: PauseState['status'];
  periodStart: Date;
  periodEnd: Date;
  periodAmountPaise: number;
  registrationFeePaise: number;
  addOnsPaise: number;
  /** Spec 2.9: the refund-if-never-attended path hinges on this. */
  sessionsAttended: number;
  membershipStartDate: Date;
}

export interface CancellationApproval {
  allowed: true;
  /** When the membership actually ends, after the club's notice period. */
  effectiveDate: Date;
  noticeDays: number;
  refundPaise: number;
  creditPaise: number;
  /** The rule that produced this outcome, for the confirmation screen. */
  basis: 'NEVER_ATTENDED_REFUND' | 'PRORATED_REFUND' | 'CARRYOVER_CREDIT' | 'NO_REFUND';
  summary: string;
}

export type CancellationVerdict = CancellationApproval | PolicyRefusal;

/**
 * Spec 2.9 / 3.2: cancellation is subject to the club's notice period, and what
 * (if anything) comes back follows the club's refund and carryover settings.
 */
export function evaluateCancellation(params: {
  config: ClubConfig;
  state: CancellationState;
  request: CancellationRequest;
}): CancellationVerdict {
  const { config, state, request } = params;
  const policy = config.refunds;

  if (state.status === 'CANCELLED' || state.status === 'EXPIRED') {
    return {
      allowed: false,
      code: 'MEMBERSHIP_NOT_ACTIVE',
      reason: 'This membership has already ended.',
    };
  }

  const effectiveDate = new Date(request.requestedOn);
  effectiveDate.setDate(effectiveDate.getDate() + policy.cancellationNoticeDays);

  // --- Never attended -------------------------------------------------------
  // Checked first: it is the most generous branch and the one members most
  // often ask about.
  if (state.sessionsAttended === 0 && policy.refundIfNeverAttended) {
    const daysSinceStart = daysBetween(state.membershipStartDate, request.requestedOn);

    if (daysSinceStart <= policy.neverAttendedWindowDays) {
      let refundPaise = state.periodAmountPaise;
      if (policy.registrationFeeRefundable) refundPaise += state.registrationFeePaise;
      if (policy.addOnsRefundable) refundPaise += state.addOnsPaise;

      const withheld: string[] = [];
      if (!policy.registrationFeeRefundable && state.registrationFeePaise > 0) {
        withheld.push('the registration fee');
      }
      if (!policy.addOnsRefundable && state.addOnsPaise > 0) {
        withheld.push('kit and add-ons');
      }

      return {
        allowed: true,
        effectiveDate,
        noticeDays: policy.cancellationNoticeDays,
        refundPaise,
        creditPaise: 0,
        basis: 'NEVER_ATTENDED_REFUND',
        summary:
          `This player never attended a session and you are within the ${policy.neverAttendedWindowDays}-day window, so the membership fee is refunded` +
          (withheld.length > 0 ? `. ${withheld.join(' and ')} ${withheld.length === 1 ? 'is' : 'are'} non-refundable.` : '.'),
      };
    }
  }

  // --- Standard cancellation -----------------------------------------------
  const { unusedPaise } = prorateUnused({
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
    asOf: effectiveDate,
    periodAmountPaise: state.periodAmountPaise,
  });

  if (unusedPaise <= 0) {
    return {
      allowed: true,
      effectiveDate,
      noticeDays: policy.cancellationNoticeDays,
      refundPaise: 0,
      creditPaise: 0,
      basis: 'NO_REFUND',
      summary: `Your membership ends on ${effectiveDate.toDateString()}. The current paid period is fully used, so there is nothing to return.`,
    };
  }

  if (policy.carryover === 'CARRYOVER_CREDIT') {
    return {
      allowed: true,
      effectiveDate,
      noticeDays: policy.cancellationNoticeDays,
      refundPaise: 0,
      creditPaise: unusedPaise,
      basis: 'CARRYOVER_CREDIT',
      summary: `Your membership ends on ${effectiveDate.toDateString()}. The unused portion is added to your account wallet rather than refunded.`,
    };
  }

  if (policy.cancellationRefundBps > 0) {
    const refundPaise = Math.floor((unusedPaise * policy.cancellationRefundBps) / 10_000);
    return {
      allowed: true,
      effectiveDate,
      noticeDays: policy.cancellationNoticeDays,
      refundPaise,
      creditPaise: 0,
      basis: 'PRORATED_REFUND',
      summary: `Your membership ends on ${effectiveDate.toDateString()}. ${policy.cancellationRefundBps / 100}% of the unused portion is refunded.`,
    };
  }

  return {
    allowed: true,
    effectiveDate,
    noticeDays: policy.cancellationNoticeDays,
    refundPaise: 0,
    creditPaise: 0,
    basis: 'NO_REFUND',
    summary: `Your membership ends on ${effectiveDate.toDateString()}. This club does not refund or carry over the unused portion.`,
  };
}

// ---------------------------------------------------------------------------
// Upgrade / downgrade
// ---------------------------------------------------------------------------

export interface TierChangeApproval {
  allowed: true;
  direction: 'UPGRADE' | 'DOWNGRADE' | 'LATERAL';
  /** Positive = member owes this. Zero when downgrading. */
  amountDuePaise: number;
  /** Positive = member receives this as wallet credit. */
  creditDuePaise: number;
  summary: string;
}

export type TierChangeVerdict = TierChangeApproval | PolicyRefusal;

/**
 * Spec 2.9: "Upgrade / downgrade: see other tiers, pay the difference (or
 * receive credit)."
 *
 * The difference is computed on the UNUSED portion of the current period, not
 * the headline prices — a member switching on the last day of the month should
 * not pay a full month's difference.
 */
export function evaluateTierChange(params: {
  config: ClubConfig;
  currentPricePaise: number;
  targetPricePaise: number;
  periodStart: Date;
  periodEnd: Date;
  changeOn: Date;
  status: PauseState['status'];
}): TierChangeVerdict {
  const { config, currentPricePaise, targetPricePaise, periodStart, periodEnd, changeOn, status } =
    params;

  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    return {
      allowed: false,
      code: 'MEMBERSHIP_NOT_ACTIVE',
      reason: 'Only an active or paused membership can change tier.',
    };
  }

  const current = prorateUnused({
    periodStart,
    periodEnd,
    asOf: changeOn,
    periodAmountPaise: currentPricePaise,
  });
  const target = prorateUnused({
    periodStart,
    periodEnd,
    asOf: changeOn,
    periodAmountPaise: targetPricePaise,
  });

  const difference = target.unusedPaise - current.unusedPaise;

  if (difference > 0) {
    return {
      allowed: true,
      direction: 'UPGRADE',
      amountDuePaise: difference,
      creditDuePaise: 0,
      summary: `Upgrading for the remaining ${current.unusedDays} days of this period costs the difference.`,
    };
  }

  if (difference < 0) {
    // Downgrades produce credit only if the club carries value over at all.
    if (config.refunds.carryover === 'NEITHER') {
      return {
        allowed: true,
        direction: 'DOWNGRADE',
        amountDuePaise: 0,
        creditDuePaise: 0,
        summary:
          'Your new tier starts immediately. This club does not carry value over, so the difference is not credited.',
      };
    }
    return {
      allowed: true,
      direction: 'DOWNGRADE',
      amountDuePaise: 0,
      creditDuePaise: Math.abs(difference),
      summary: `The difference for the remaining ${current.unusedDays} days is added to your account wallet.`,
    };
  }

  return {
    allowed: true,
    direction: 'LATERAL',
    amountDuePaise: 0,
    creditDuePaise: 0,
    summary: 'These tiers cost the same — nothing to pay.',
  };
}

/** Type guard so callers can narrow a verdict without repeating the shape. */
export function isRefusal(verdict: { allowed: boolean }): verdict is PolicyRefusal {
  return verdict.allowed === false;
}
