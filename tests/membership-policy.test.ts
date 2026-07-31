import { describe, expect, it } from 'vitest';
import {
  evaluateCancellation,
  evaluatePause,
  evaluateTierChange,
  isRefusal,
  type CancellationState,
  type PauseState,
} from '@/domain/membership/policy';
import {
  assertPlanBalances,
  buildInstalmentPlan,
  commissionForBooking,
  formatInr,
  priceEnrollment,
  prorateUnused,
} from '@/domain/money/pricing';
import { makeConfig } from './helpers';

const PERIOD_START = new Date('2026-03-01T00:00:00Z');
const PERIOD_END = new Date('2026-03-31T00:00:00Z');
const MONTHLY_PAISE = 300_000; // ₹3,000

function pauseState(over: Partial<PauseState> = {}): PauseState {
  return {
    status: 'ACTIVE',
    daysPausedThisYear: 0,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    periodAmountPaise: MONTHLY_PAISE,
    ...over,
  };
}

function cancellationState(over: Partial<CancellationState> = {}): CancellationState {
  return {
    status: 'ACTIVE',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    periodAmountPaise: MONTHLY_PAISE,
    registrationFeePaise: 100_000,
    addOnsPaise: 80_000,
    sessionsAttended: 10,
    membershipStartDate: PERIOD_START,
    ...over,
  };
}

describe('pause policy (spec 2.9)', () => {
  const request = {
    reason: 'INJURY' as const,
    startDate: new Date('2026-03-11T00:00:00Z'),
    endDate: new Date('2026-03-25T00:00:00Z'),
    requestedOn: new Date('2026-03-05T00:00:00Z'),
    hasProof: false,
  };

  it('refuses when the club does not allow pauses', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { allowed: false } }),
      state: pauseState(),
      request,
    });
    expect(isRefusal(verdict)).toBe(true);
    expect(verdict).toMatchObject({ code: 'PAUSE_NOT_ALLOWED' });
  });

  it('refuses a pause on a membership that is not active', () => {
    const verdict = evaluatePause({
      config: makeConfig(),
      state: pauseState({ status: 'PAUSED' }),
      request,
    });
    expect(verdict).toMatchObject({ code: 'MEMBERSHIP_NOT_ACTIVE' });
  });

  it('refuses a reason the club does not accept', () => {
    const verdict = evaluatePause({
      config: makeConfig(),
      state: pauseState(),
      request: { ...request, reason: 'TRAVEL' },
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_REASON_NOT_ACCEPTED' });
  });

  it('accepts travel when the club opted into it', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { acceptedReasons: ['INJURY', 'ILLNESS', 'TRAVEL'] } }),
      state: pauseState(),
      request: { ...request, reason: 'TRAVEL' },
    });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses too little notice', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { noticeDays: 10 } }),
      state: pauseState(),
      request,
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_NOTICE_TOO_SHORT' });
  });

  it('refuses a pause shorter than the minimum', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { minDays: 20 } }),
      state: pauseState(),
      request,
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_TOO_SHORT' });
  });

  it('refuses a pause that exceeds the annual allowance and says how much is left', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { maxDaysPerYear: 20 } }),
      state: pauseState({ daysPausedThisYear: 12 }),
      request,
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_ALLOWANCE_EXCEEDED' });
    if (isRefusal(verdict)) {
      expect(verdict.details?.remainingDays).toBe(8);
    }
  });

  it('refuses a long pause with no supporting documentation', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { maxDaysPerYear: 120, proofRequiredAboveDays: 10 } }),
      state: pauseState(),
      request,
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_PROOF_REQUIRED' });
  });

  it('allows it once proof is attached', () => {
    const verdict = evaluatePause({
      config: makeConfig({ pause: { maxDaysPerYear: 120, proofRequiredAboveDays: 10 } }),
      state: pauseState(),
      request: { ...request, hasProof: true },
    });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses an end date on or before the start date', () => {
    const verdict = evaluatePause({
      config: makeConfig(),
      state: pauseState(),
      request: { ...request, endDate: request.startDate },
    });
    expect(verdict).toMatchObject({ code: 'PAUSE_DATES_INVALID' });
  });

  describe('carryover outcomes', () => {
    it('credits the wallet under CARRYOVER_CREDIT', () => {
      const verdict = evaluatePause({
        config: makeConfig({ refunds: { carryover: 'CARRYOVER_CREDIT' } }),
        state: pauseState(),
        request,
      });
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        expect(verdict.outcome).toBe('CARRYOVER_CREDIT');
        // 14 days of a 30-day ₹3,000 month.
        expect(verdict.carryoverPaise).toBe(140_000);
        expect(verdict.extendPeriodByDays).toBe(0);
        expect(verdict.summary).toMatch(/wallet/);
      }
    });

    it('extends the period under ADJUST_NEXT_MONTH', () => {
      const verdict = evaluatePause({
        config: makeConfig({ refunds: { carryover: 'ADJUST_NEXT_MONTH' } }),
        state: pauseState(),
        request,
      });
      if (verdict.allowed) {
        expect(verdict.outcome).toBe('ADJUST_NEXT_MONTH');
        expect(verdict.carryoverPaise).toBe(0);
        expect(verdict.extendPeriodByDays).toBe(14);
      }
    });

    it('gives nothing back under NEITHER', () => {
      const verdict = evaluatePause({
        config: makeConfig({ refunds: { carryover: 'NEITHER' } }),
        state: pauseState(),
        request,
      });
      if (verdict.allowed) {
        expect(verdict.outcome).toBe('NEITHER');
        expect(verdict.carryoverPaise).toBe(0);
        expect(verdict.extendPeriodByDays).toBe(0);
      }
    });

    it('never credits more than the pause is actually worth', () => {
      // A 14-day pause on a 30-day period cannot be worth the whole month, even
      // though 20 days of the period remain unused.
      const verdict = evaluatePause({
        config: makeConfig(),
        state: pauseState(),
        request,
      });
      if (verdict.allowed) {
        expect(verdict.carryoverPaise).toBeLessThan(MONTHLY_PAISE);
      }
    });
  });
});

describe('cancellation policy (spec 2.9)', () => {
  const request = { requestedOn: new Date('2026-03-10T00:00:00Z') };

  it('applies the club’s notice period to the effective date', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { cancellationNoticeDays: 30 } }),
      state: cancellationState(),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.noticeDays).toBe(30);
      expect(verdict.effectiveDate.toISOString().slice(0, 10)).toBe('2026-04-09');
    }
  });

  it('refunds a player who never attended, inside the window', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { refundIfNeverAttended: true, neverAttendedWindowDays: 14 } }),
      state: cancellationState({ sessionsAttended: 0 }),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).toBe('NEVER_ATTENDED_REFUND');
      expect(verdict.refundPaise).toBe(MONTHLY_PAISE);
    }
  });

  it('withholds the registration fee and kit when the club says they are non-refundable', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({
        refunds: { refundIfNeverAttended: true, registrationFeeRefundable: false, addOnsRefundable: false },
      }),
      state: cancellationState({ sessionsAttended: 0 }),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.refundPaise).toBe(MONTHLY_PAISE);
      expect(verdict.summary).toMatch(/non-refundable/);
    }
  });

  it('includes the registration fee when the club says it is refundable', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({
        refunds: { refundIfNeverAttended: true, registrationFeeRefundable: true, addOnsRefundable: true },
      }),
      state: cancellationState({ sessionsAttended: 0 }),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.refundPaise).toBe(MONTHLY_PAISE + 100_000 + 80_000);
    }
  });

  it('does not use the never-attended path outside the window', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { neverAttendedWindowDays: 5 } }),
      state: cancellationState({ sessionsAttended: 0 }),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).not.toBe('NEVER_ATTENDED_REFUND');
    }
  });

  it('does not use it at all when the club has that refund switched off', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { refundIfNeverAttended: false } }),
      state: cancellationState({ sessionsAttended: 0 }),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).not.toBe('NEVER_ATTENDED_REFUND');
    }
  });

  it('credits the unused portion under CARRYOVER_CREDIT', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { carryover: 'CARRYOVER_CREDIT', cancellationNoticeDays: 0 } }),
      state: cancellationState(),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).toBe('CARRYOVER_CREDIT');
      expect(verdict.creditPaise).toBe(210_000); // 21 of 30 days
      expect(verdict.refundPaise).toBe(0);
    }
  });

  it('refunds a percentage when the club configured one', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({
        refunds: { carryover: 'NEITHER', cancellationRefundBps: 5000, cancellationNoticeDays: 0 },
      }),
      state: cancellationState(),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).toBe('PRORATED_REFUND');
      expect(verdict.refundPaise).toBe(105_000); // 50% of 210_000
    }
  });

  it('returns nothing when the notice period runs past the paid period', () => {
    const verdict = evaluateCancellation({
      config: makeConfig({ refunds: { cancellationNoticeDays: 60 } }),
      state: cancellationState(),
      request,
    });
    if (verdict.allowed) {
      expect(verdict.basis).toBe('NO_REFUND');
      expect(verdict.refundPaise).toBe(0);
      expect(verdict.creditPaise).toBe(0);
    }
  });

  it('refuses to cancel an already-cancelled membership', () => {
    const verdict = evaluateCancellation({
      config: makeConfig(),
      state: cancellationState({ status: 'CANCELLED' }),
      request,
    });
    expect(verdict).toMatchObject({ code: 'MEMBERSHIP_NOT_ACTIVE' });
  });
});

describe('tier change (spec 2.9)', () => {
  const base = {
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    changeOn: new Date('2026-03-16T00:00:00Z'),
    status: 'ACTIVE' as const,
  };

  it('charges only the prorated difference on an upgrade', () => {
    const verdict = evaluateTierChange({
      config: makeConfig(),
      currentPricePaise: 300_000,
      targetPricePaise: 500_000,
      ...base,
    });
    if (verdict.allowed) {
      expect(verdict.direction).toBe('UPGRADE');
      // 15 of 30 days remaining → half of the ₹2,000 difference.
      expect(verdict.amountDuePaise).toBe(100_000);
    }
  });

  it('credits the prorated difference on a downgrade', () => {
    const verdict = evaluateTierChange({
      config: makeConfig({ refunds: { carryover: 'CARRYOVER_CREDIT' } }),
      currentPricePaise: 500_000,
      targetPricePaise: 300_000,
      ...base,
    });
    if (verdict.allowed) {
      expect(verdict.direction).toBe('DOWNGRADE');
      expect(verdict.creditDuePaise).toBe(100_000);
      expect(verdict.amountDuePaise).toBe(0);
    }
  });

  it('credits nothing on a downgrade when the club carries nothing over', () => {
    const verdict = evaluateTierChange({
      config: makeConfig({ refunds: { carryover: 'NEITHER' } }),
      currentPricePaise: 500_000,
      targetPricePaise: 300_000,
      ...base,
    });
    if (verdict.allowed) {
      expect(verdict.creditDuePaise).toBe(0);
    }
  });

  it('charges nothing for a lateral move', () => {
    const verdict = evaluateTierChange({
      config: makeConfig(),
      currentPricePaise: 300_000,
      targetPricePaise: 300_000,
      ...base,
    });
    if (verdict.allowed) {
      expect(verdict.direction).toBe('LATERAL');
      expect(verdict.amountDuePaise).toBe(0);
    }
  });

  it('refuses on a cancelled membership', () => {
    const verdict = evaluateTierChange({
      config: makeConfig(),
      currentPricePaise: 300_000,
      targetPricePaise: 500_000,
      ...base,
      status: 'CANCELLED',
    });
    expect(verdict).toMatchObject({ code: 'MEMBERSHIP_NOT_ACTIVE' });
  });
});

describe('pricing (spec 2.5 / 2.8)', () => {
  const addOns = [
    { name: 'Club jersey', pricePaise: 120_000, mandatory: true, oneTime: true },
    { name: 'Training kit', pricePaise: 250_000, mandatory: false, oneTime: true },
  ];

  it('shows registration and add-ons as separate lines', () => {
    const breakdown = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly — Elite',
      registrationFeePaise: 100_000,
      chargeRegistration: true,
      addOns,
      selectedAddOnNames: [],
    });

    expect(breakdown.lines.map((line) => line.kind)).toEqual(['BASE', 'REGISTRATION', 'ADDON']);
    expect(breakdown.totalPaise).toBe(300_000 + 100_000 + 120_000);
  });

  it('always charges mandatory add-ons, even if the client omits them', () => {
    const breakdown = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly',
      registrationFeePaise: 0,
      chargeRegistration: false,
      addOns,
      selectedAddOnNames: [],
    });
    expect(breakdown.lines.some((line) => line.label === 'Club jersey')).toBe(true);
  });

  it('includes optional add-ons only when selected', () => {
    const without = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly',
      registrationFeePaise: 0,
      chargeRegistration: false,
      addOns,
      selectedAddOnNames: [],
    });
    const with_ = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly',
      registrationFeePaise: 0,
      chargeRegistration: false,
      addOns,
      selectedAddOnNames: ['Training kit'],
    });
    expect(with_.totalPaise - without.totalPaise).toBe(250_000);
  });

  it('skips registration for a player who already paid it', () => {
    const breakdown = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly',
      registrationFeePaise: 100_000,
      chargeRegistration: false,
      addOns: [],
      selectedAddOnNames: [],
    });
    expect(breakdown.totalPaise).toBe(300_000);
  });

  it('applies wallet credit and never lets it exceed the subtotal', () => {
    const breakdown = priceEnrollment({
      packagePricePaise: 300_000,
      packageLabel: 'Monthly',
      registrationFeePaise: 0,
      chargeRegistration: false,
      addOns: [],
      selectedAddOnNames: [],
      availableCreditPaise: 500_000,
      applyCredit: true,
    });
    expect(breakdown.creditAppliedPaise).toBe(300_000);
    expect(breakdown.totalPaise).toBe(0);
  });
});

describe('instalment plans (spec 2.8)', () => {
  const startDate = new Date('2026-03-01T00:00:00Z');

  it('produces a single payment when part payment is off', () => {
    const plan = buildInstalmentPlan({
      totalPaise: 300_000,
      config: makeConfig(),
      startDate,
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.amountPaise).toBe(300_000);
  });

  it('splits into the configured number of instalments', () => {
    const plan = buildInstalmentPlan({
      totalPaise: 300_000,
      config: makeConfig({ payments: { partPaymentAllowed: true, partPaymentSplits: 3 } }),
      startDate,
    });
    expect(plan.entries).toHaveLength(3);
  });

  it('always balances exactly, including on amounts that do not divide evenly', () => {
    for (const total of [300_000, 299_999, 100_001, 7, 1_234_567]) {
      const plan = buildInstalmentPlan({
        totalPaise: total,
        config: makeConfig({ payments: { partPaymentAllowed: true, partPaymentSplits: 3 } }),
        startDate,
      });
      expect(() => assertPlanBalances(plan)).not.toThrow();
    }
  });

  it('spaces instalments by the configured gap', () => {
    const plan = buildInstalmentPlan({
      totalPaise: 300_000,
      config: makeConfig({
        payments: { partPaymentAllowed: true, partPaymentSplits: 3, partPaymentGapDays: 15 },
      }),
      startDate,
    });
    expect(plan.entries[1]?.dueDate.toISOString().slice(0, 10)).toBe('2026-03-16');
    expect(plan.entries[2]?.dueDate.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('honours the upfront share', () => {
    const plan = buildInstalmentPlan({
      totalPaise: 400_000,
      config: makeConfig({
        payments: { partPaymentAllowed: true, partPaymentSplits: 2, partPaymentUpfrontBps: 2500 },
      }),
      startDate,
    });
    expect(plan.upfrontPaise).toBe(100_000);
    expect(plan.entries[1]?.amountPaise).toBe(300_000);
  });

  it('handles a zero total without dividing by zero', () => {
    const plan = buildInstalmentPlan({
      totalPaise: 0,
      config: makeConfig({ payments: { partPaymentAllowed: true, partPaymentSplits: 3 } }),
      startDate,
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.amountPaise).toBe(0);
  });
});

describe('proration', () => {
  it('returns zero once the period has passed', () => {
    const result = prorateUnused({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      asOf: new Date('2026-04-15T00:00:00Z'),
      periodAmountPaise: MONTHLY_PAISE,
    });
    expect(result.unusedPaise).toBe(0);
  });

  it('returns the full amount before the period starts', () => {
    const result = prorateUnused({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      asOf: new Date('2026-02-01T00:00:00Z'),
      periodAmountPaise: MONTHLY_PAISE,
    });
    expect(result.unusedPaise).toBe(MONTHLY_PAISE);
  });

  it('splits proportionally in the middle', () => {
    const result = prorateUnused({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      asOf: new Date('2026-03-16T00:00:00Z'),
      periodAmountPaise: MONTHLY_PAISE,
    });
    expect(result.unusedDays).toBe(15);
    expect(result.unusedPaise).toBe(150_000);
  });
});

describe('commission (spec 5.4 / 7)', () => {
  it('splits a booking into commission and payout', () => {
    expect(commissionForBooking(200_000, 1_000)).toEqual({
      commissionPaise: 20_000,
      payoutPaise: 180_000,
    });
  });

  it('never loses a paisa to rounding', () => {
    for (const amount of [12_345, 99_999, 1, 7_777_777]) {
      const { commissionPaise, payoutPaise } = commissionForBooking(amount, 1_250);
      expect(commissionPaise + payoutPaise).toBe(amount);
    }
  });
});

describe('currency formatting', () => {
  it('formats whole rupees without decimals', () => {
    expect(formatInr(250_000)).toMatch(/2,500/);
  });

  it('keeps paise when they are non-zero', () => {
    expect(formatInr(250_050)).toMatch(/2,500\.50/);
  });
});
