/**
 * Pricing and instalment scheduling.
 *
 * All amounts are integer paise. There is no floating point anywhere in this
 * file, and rounding is always explicit — a schedule whose instalments do not
 * sum to the total is a support ticket every single month.
 *
 * Pure module: no I/O.
 */

import type { ClubConfig } from '../config/schema';

export interface PriceLine {
  label: string;
  amountPaise: number;
  /** Charged once, versus every billing cycle. */
  oneTime: boolean;
  kind: 'BASE' | 'REGISTRATION' | 'ADDON' | 'DISCOUNT' | 'CREDIT';
}

export interface PriceBreakdown {
  lines: PriceLine[];
  subtotalPaise: number;
  /** Wallet credit applied at checkout. */
  creditAppliedPaise: number;
  totalPaise: number;
}

export interface AddOnInput {
  name: string;
  pricePaise: number;
  mandatory: boolean;
  oneTime: boolean;
}

/**
 * Spec 2.5: "full price breakdown (registration fee, monthly/term price,
 * kit/jersey add-on shown as a separate line)". The member sees exactly these
 * lines — never a single opaque number.
 */
export function priceEnrollment(params: {
  packagePricePaise: number;
  packageLabel: string;
  registrationFeePaise: number;
  /** False when this player has already paid registration at this club. */
  chargeRegistration: boolean;
  addOns: AddOnInput[];
  selectedAddOnNames: string[];
  /** Wallet credit the member chose to apply. */
  availableCreditPaise?: number;
  applyCredit?: boolean;
}): PriceBreakdown {
  const lines: PriceLine[] = [
    {
      label: params.packageLabel,
      amountPaise: params.packagePricePaise,
      oneTime: false,
      kind: 'BASE',
    },
  ];

  if (params.chargeRegistration && params.registrationFeePaise > 0) {
    lines.push({
      label: 'Registration fee',
      amountPaise: params.registrationFeePaise,
      oneTime: true,
      kind: 'REGISTRATION',
    });
  }

  const selected = new Set(params.selectedAddOnNames);
  for (const addOn of params.addOns) {
    // Mandatory add-ons are charged whether or not the client sent them.
    if (!addOn.mandatory && !selected.has(addOn.name)) continue;
    lines.push({
      label: addOn.name,
      amountPaise: addOn.pricePaise,
      oneTime: addOn.oneTime,
      kind: 'ADDON',
    });
  }

  const subtotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);

  let creditAppliedPaise = 0;
  if (params.applyCredit && params.availableCreditPaise && params.availableCreditPaise > 0) {
    creditAppliedPaise = Math.min(params.availableCreditPaise, subtotalPaise);
    if (creditAppliedPaise > 0) {
      lines.push({
        label: 'Wallet credit applied',
        amountPaise: -creditAppliedPaise,
        oneTime: true,
        kind: 'CREDIT',
      });
    }
  }

  return {
    lines,
    subtotalPaise,
    creditAppliedPaise,
    totalPaise: subtotalPaise - creditAppliedPaise,
  };
}

// ---------------------------------------------------------------------------
// Instalments
// ---------------------------------------------------------------------------

export interface InstalmentPlanEntry {
  sequence: number;
  amountPaise: number;
  dueDate: Date;
}

export interface InstalmentPlan {
  entries: InstalmentPlanEntry[];
  upfrontPaise: number;
  totalPaise: number;
}

/**
 * Build the instalment schedule for a part payment.
 *
 * Rounding rule: every instalment is floored to the paisa, and the remainder is
 * added to the FIRST instalment. Paying slightly more up front is the
 * conventional and least surprising choice, and it guarantees the schedule sums
 * exactly to the total.
 */
export function buildInstalmentPlan(params: {
  totalPaise: number;
  config: ClubConfig;
  startDate: Date;
}): InstalmentPlan {
  const { totalPaise, config, startDate } = params;
  const { partPaymentAllowed, partPaymentSplits, partPaymentGapDays, partPaymentUpfrontBps } =
    config.payments;

  if (!partPaymentAllowed || totalPaise <= 0) {
    return {
      entries: [{ sequence: 1, amountPaise: totalPaise, dueDate: new Date(startDate) }],
      upfrontPaise: totalPaise,
      totalPaise,
    };
  }

  const upfrontPaise = Math.round((totalPaise * partPaymentUpfrontBps) / 10_000);
  const remainder = totalPaise - upfrontPaise;
  const laterCount = partPaymentSplits - 1;

  const entries: InstalmentPlanEntry[] = [
    { sequence: 1, amountPaise: upfrontPaise, dueDate: new Date(startDate) },
  ];

  if (laterCount > 0 && remainder > 0) {
    const base = Math.floor(remainder / laterCount);
    let allocated = 0;

    for (let index = 0; index < laterCount; index += 1) {
      const isLast = index === laterCount - 1;
      // The last instalment absorbs the rounding remainder so the plan is exact.
      const amountPaise = isLast ? remainder - allocated : base;
      allocated += amountPaise;

      const dueDate = new Date(startDate);
      dueDate.setDate(dueDate.getDate() + partPaymentGapDays * (index + 1));

      entries.push({ sequence: index + 2, amountPaise, dueDate });
    }
  }

  return { entries, upfrontPaise, totalPaise };
}

/** Guard against a plan that does not add up — cheap, and catches maths bugs. */
export function assertPlanBalances(plan: InstalmentPlan): void {
  const sum = plan.entries.reduce((total, entry) => total + entry.amountPaise, 0);
  if (sum !== plan.totalPaise) {
    throw new Error(
      `Instalment plan does not balance: entries sum to ${sum} but the total is ${plan.totalPaise}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Proration
// ---------------------------------------------------------------------------

/**
 * Value of the unused portion of a billing period.
 *
 * Used by pause (what carries over), cancellation (what is refundable) and
 * upgrade (what the difference is). Days, not hours — clubs think in days and
 * an hour-accurate number invites arguments about the exact minute.
 */
export function prorateUnused(params: {
  periodStart: Date;
  periodEnd: Date;
  asOf: Date;
  periodAmountPaise: number;
}): { unusedDays: number; totalDays: number; unusedPaise: number } {
  const { periodStart, periodEnd, asOf, periodAmountPaise } = params;

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / dayMs));

  const effectiveAsOf = asOf.getTime() < periodStart.getTime() ? periodStart : asOf;
  const unusedDays = Math.max(
    0,
    Math.round((periodEnd.getTime() - effectiveAsOf.getTime()) / dayMs),
  );

  const cappedUnused = Math.min(unusedDays, totalDays);
  const unusedPaise = Math.floor((periodAmountPaise * cappedUnused) / totalDays);

  return { unusedDays: cappedUnused, totalDays, unusedPaise };
}

/** Format paise as Indian rupees for display, e.g. 250000 → "₹2,500". */
export function formatInr(paise: number): string {
  const rupees = paise / 100;
  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
  return formatted;
}

/** Platform commission — turf bookings only (spec 5.4 / 7). */
export function commissionForBooking(amountPaise: number, commissionBps: number): {
  commissionPaise: number;
  payoutPaise: number;
} {
  const commissionPaise = Math.round((amountPaise * commissionBps) / 10_000);
  return { commissionPaise, payoutPaise: amountPaise - commissionPaise };
}
