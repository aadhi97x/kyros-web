/**
 * The enrollment state machine.
 *
 * Spec 2.7: "This is the trickiest part of the product. The member-facing flow
 * branches at runtime on the club's config object. Build it as a config-driven
 * state machine, not as hardcoded screens."
 *
 * Design: rather than a transition table, this is a deterministic *evaluator*.
 * Given the full observable state of one enrollment attempt, it returns the one
 * step the member is on right now. That makes it:
 *   - idempotent (recomputing after a refresh, a resume, or an app reinstall
 *     always lands on the same step),
 *   - exhaustively testable (no hidden history to set up),
 *   - safe against a club changing its config mid-enrollment — the next
 *     evaluation simply reflects the new rules.
 *
 * The member app renders whatever `step` comes back. It must not infer the next
 * screen itself. The server re-evaluates on every mutation, so a client that
 * skips a step gets rejected.
 *
 * Pure module: no I/O, no framework imports.
 */

import type { ClubConfig } from '../config/schema';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const enrollmentSteps = [
  /** A minor's data cannot be processed before verified, specific consent. */
  'CONSENT_REQUIRED',
  /** Club runs demos and this player has not booked one. */
  'BOOK_DEMO',
  /** Demo booked, not yet held. */
  'AWAITING_DEMO',
  /** Demo held; the coach has not recorded feedback yet. */
  'AWAITING_DEMO_FEEDBACK',
  /** Spec 2.6: feedback + recommended batch/package + "what happens next". */
  'POST_DEMO_REVIEW',
  /** Coach-assigned club, no batch assigned yet. */
  'AWAITING_BATCH_ASSIGNMENT',
  /** Member self-select club, no batch chosen yet. */
  'SELECT_BATCH',
  /** Batch settled, package not chosen. */
  'SELECT_PACKAGE',
  /** Player's age falls outside the batch's band and the club enforces it. */
  'AGE_BAND_MISMATCH',
  /** Batch full, waitlist on — offer to queue. */
  'OFFER_WAITLIST',
  /** Batch full, waitlist off — dead end. */
  'CAPACITY_BLOCKED',
  /** Sitting in the queue. */
  'WAITLISTED',
  /** Club offers a trial class and the member has not used it. */
  'TRIAL_AVAILABLE',
  /** Everything chosen; money owed. */
  'PAYMENT',
  /** Part payment: upfront paid, instalments outstanding. */
  'PAYMENT_INSTALMENTS_PENDING',
  /** Paid, but the club gates on human approval. */
  'AWAITING_APPROVAL',
  /** Club rejected the enrollment. */
  'REJECTED',
  /** Done. */
  'ACTIVE',
] as const;

export type EnrollmentStep = (typeof enrollmentSteps)[number];

/** Terminal steps — nothing the member does moves them forward from here. */
const TERMINAL_STEPS = new Set<EnrollmentStep>(['ACTIVE', 'CAPACITY_BLOCKED', 'REJECTED']);

export function isTerminal(step: EnrollmentStep): boolean {
  return TERMINAL_STEPS.has(step);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface EnrollmentPlayer {
  id: string;
  /** Derived from DOB upstream — never trusted from the client. */
  isMinor: boolean;
  ageYears: number;
  /** An ACTIVE consent record covering this club's processing scopes. */
  hasActiveConsent: boolean;
}

export interface EnrollmentBatch {
  id: string;
  capacity: number;
  activeCount: number;
  minAge: number;
  maxAge: number;
  waitlistSize: number;
}

export interface EnrollmentPackage {
  id: string;
  batchId: string | null;
  /** Total owed in paise, add-ons included. */
  totalPaise: number;
}

export interface EnrollmentDemo {
  status: 'REQUESTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  /** The coach has written up the demo. */
  feedbackRecorded: boolean;
  /** Member has seen and dismissed the post-demo screen. */
  reviewAcknowledged: boolean;
  recommendedBatchId: string | null;
  recommendedPackageId: string | null;
}

export interface EnrollmentPayment {
  /** Total settled so far, in paise. */
  paidPaise: number;
  totalPaise: number;
  isPartPayment: boolean;
  /** Instalments still due (excluding any paid upfront amount). */
  outstandingInstalments: number;
}

/**
 * Everything the evaluator is allowed to look at. If a decision needs a fact
 * that is not here, add it here — do not reach for the database inside the
 * evaluator.
 */
export interface EnrollmentContext {
  config: ClubConfig;
  player: EnrollmentPlayer;
  /** Batch the member picked, or the coach assigned. Null until settled. */
  batch: EnrollmentBatch | null;
  package: EnrollmentPackage | null;
  demo: EnrollmentDemo | null;
  payment: EnrollmentPayment | null;
  /** Member is already queued for `batch`. */
  onWaitlist: boolean;
  /** Member consumed the trial class already. */
  trialUsed: boolean;
  /** Club decision when `enrollment.approval === 'REQUIRED'`. */
  approval: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  /** Member explicitly declined the waitlist offer, so stop re-offering it. */
  waitlistDeclined: boolean;
}

export interface EnrollmentDecision {
  step: EnrollmentStep;
  /** Why this step, in plain language — surfaced in the app and in support. */
  reason: string;
  /** Steps already satisfied, for the progress indicator. */
  completed: EnrollmentStep[];
  /** What the member can do from here. Drives the CTA buttons. */
  availableActions: EnrollmentAction[];
  terminal: boolean;
}

export const enrollmentActions = [
  'GRANT_CONSENT',
  'BOOK_DEMO',
  'CANCEL_DEMO',
  'ACKNOWLEDGE_DEMO_REVIEW',
  'SELECT_BATCH',
  'SELECT_PACKAGE',
  'CHANGE_BATCH',
  'JOIN_WAITLIST',
  'DECLINE_WAITLIST',
  'LEAVE_WAITLIST',
  'START_TRIAL',
  'SKIP_TRIAL',
  'PAY_FULL',
  'PAY_INSTALMENT',
  'CONTACT_CLUB',
  'BROWSE_OTHER_BATCHES',
  'NONE',
] as const;

export type EnrollmentAction = (typeof enrollmentActions)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function batchHasSpace(batch: EnrollmentBatch): boolean {
  return batch.activeCount < batch.capacity;
}

export function waitlistHasRoom(config: ClubConfig, batch: EnrollmentBatch): boolean {
  if (!config.enrollment.waitlistEnabled) return false;
  const max = config.enrollment.waitlistMaxSize;
  return max === 0 || batch.waitlistSize < max;
}

export function ageWithinBand(config: ClubConfig, player: EnrollmentPlayer, batch: EnrollmentBatch): boolean {
  if (!config.enrollment.enforceAgeBand) return true;
  const tolerance = config.enrollment.ageBandToleranceYears;
  return player.ageYears >= batch.minAge - tolerance && player.ageYears <= batch.maxAge + tolerance;
}

function demoIsSettled(demo: EnrollmentDemo | null): boolean {
  // A cancelled or no-show demo does not count as done — the member is back at
  // "book a demo".
  return demo !== null && demo.status === 'COMPLETED';
}

function paymentSettled(payment: EnrollmentPayment | null): boolean {
  if (!payment) return false;
  if (payment.isPartPayment) {
    // Part payment activates the membership on the FIRST successful payment;
    // the remaining instalments run alongside an active membership.
    return payment.paidPaise > 0;
  }
  return payment.paidPaise >= payment.totalPaise;
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/**
 * Resolve the single step this enrollment attempt is on.
 *
 * Order matters and encodes the product's priorities:
 *   1. Legal gate (consent) — nothing happens before it.
 *   2. Club's assessment gate (demo) — the club decides who joins.
 *   3. Placement (batch, then package).
 *   4. Capacity.
 *   5. Trial.
 *   6. Money.
 *   7. Approval.
 */
export function resolveEnrollmentStep(context: EnrollmentContext): EnrollmentDecision {
  const { config, player, batch, demo, payment } = context;
  const completed: EnrollmentStep[] = [];

  // --- 1. Consent -----------------------------------------------------------
  // Spec 2.3 / 7: consent is mandatory before processing any minor's data.
  // This gate precedes everything, including browsing-to-enroll.
  if (player.isMinor && !player.hasActiveConsent) {
    return decide('CONSENT_REQUIRED', 'This player is a minor and needs verified guardian consent before enrolling.', completed, ['GRANT_CONSENT']);
  }
  if (player.isMinor) completed.push('CONSENT_REQUIRED');

  // --- 2. Approval outcome --------------------------------------------------
  // A rejection is terminal regardless of what else is true, so it is checked
  // before the happy path can conclude ACTIVE.
  if (context.approval === 'REJECTED') {
    return decide('REJECTED', 'The club did not approve this enrollment.', completed, ['CONTACT_CLUB', 'BROWSE_OTHER_BATCHES']);
  }

  // --- 3. Demo gate ---------------------------------------------------------
  if (config.demo.enabled && config.demo.requiredBeforeEnrollment) {
    if (!demo || demo.status === 'CANCELLED' || demo.status === 'NO_SHOW') {
      return decide('BOOK_DEMO', 'This club requires a demo session before enrolling.', completed, ['BOOK_DEMO']);
    }

    if (demo.status === 'REQUESTED' || demo.status === 'CONFIRMED') {
      return decide('AWAITING_DEMO', 'Demo booked. See you at the session.', completed, ['CANCEL_DEMO']);
    }

    if (demo.status === 'COMPLETED' && !demo.feedbackRecorded) {
      return decide('AWAITING_DEMO_FEEDBACK', 'The coach is writing up the demo. You will be notified when it is ready.', completed, ['NONE']);
    }

    if (demo.status === 'COMPLETED' && demo.feedbackRecorded && !demo.reviewAcknowledged) {
      return decide('POST_DEMO_REVIEW', 'Your coach feedback and recommended batch are ready.', completed, ['ACKNOWLEDGE_DEMO_REVIEW']);
    }
  }

  if (demoIsSettled(demo)) {
    completed.push('BOOK_DEMO', 'AWAITING_DEMO', 'AWAITING_DEMO_FEEDBACK', 'POST_DEMO_REVIEW');
  }

  // --- 4. Batch placement ---------------------------------------------------
  if (!batch) {
    if (config.enrollment.batchAssignment === 'COACH_ASSIGNED') {
      // With demos on, the recommendation comes out of the demo. Without demos,
      // the club has to place the player some other way, so the member simply
      // waits.
      const hasRecommendation = demo?.recommendedBatchId != null;
      return decide(
        'AWAITING_BATCH_ASSIGNMENT',
        hasRecommendation
          ? 'Your coach has recommended a batch — confirming placement.'
          : 'A coach will assign the right batch for this player.',
        completed,
        ['CONTACT_CLUB'],
      );
    }
    return decide('SELECT_BATCH', 'Choose the batch you would like to join.', completed, ['SELECT_BATCH']);
  }
  completed.push(config.enrollment.batchAssignment === 'COACH_ASSIGNED' ? 'AWAITING_BATCH_ASSIGNMENT' : 'SELECT_BATCH');

  // --- 5. Age band ----------------------------------------------------------
  if (!ageWithinBand(config, player, batch)) {
    return decide(
      'AGE_BAND_MISMATCH',
      `This batch is for ages ${batch.minAge}–${batch.maxAge}; this player is ${player.ageYears}.`,
      completed,
      config.enrollment.batchAssignment === 'MEMBER_SELF_SELECT'
        ? ['CHANGE_BATCH', 'BROWSE_OTHER_BATCHES']
        : ['CONTACT_CLUB'],
    );
  }

  // --- 6. Capacity ----------------------------------------------------------
  // Spec 7: "Enrollment is blocked at batch capacity unless the waitlist is
  // enabled." An already-active membership is past this gate, so capacity is
  // only evaluated while the enrollment is still in flight.
  const alreadySettled = paymentSettled(payment);

  if (!batchHasSpace(batch) && !alreadySettled) {
    if (context.onWaitlist) {
      return decide('WAITLISTED', 'You are on the waitlist. We will notify you the moment a place opens.', completed, ['LEAVE_WAITLIST', 'BROWSE_OTHER_BATCHES']);
    }
    if (waitlistHasRoom(config, batch) && !context.waitlistDeclined) {
      return decide('OFFER_WAITLIST', 'This batch is full. You can join the waitlist.', completed, ['JOIN_WAITLIST', 'DECLINE_WAITLIST', 'BROWSE_OTHER_BATCHES']);
    }
    const why = !config.enrollment.waitlistEnabled
      ? 'This batch is full and the club does not run a waitlist.'
      : context.waitlistDeclined
        ? 'This batch is full and you declined the waitlist.'
        : 'This batch is full and its waitlist is also full.';
    return decide('CAPACITY_BLOCKED', why, completed, ['BROWSE_OTHER_BATCHES', 'CONTACT_CLUB']);
  }

  // --- 7. Package -----------------------------------------------------------
  if (!context.package) {
    return decide('SELECT_PACKAGE', 'Choose a package for this batch.', completed, ['SELECT_PACKAGE']);
  }
  completed.push('SELECT_PACKAGE');

  // --- 8. Trial -------------------------------------------------------------
  // Offered after placement but before money, so the member knows exactly what
  // they are trialling.
  if (config.enrollment.trialClassEnabled && !context.trialUsed && !alreadySettled) {
    return decide(
      'TRIAL_AVAILABLE',
      `This club offers ${config.enrollment.trialClassCount} trial ${config.enrollment.trialClassCount === 1 ? 'class' : 'classes'} before you commit.`,
      completed,
      ['START_TRIAL', 'SKIP_TRIAL', 'PAY_FULL'],
    );
  }
  if (config.enrollment.trialClassEnabled) completed.push('TRIAL_AVAILABLE');

  // --- 9. Payment -----------------------------------------------------------
  if (!alreadySettled) {
    const actions: EnrollmentAction[] = config.payments.partPaymentAllowed
      ? ['PAY_FULL', 'PAY_INSTALMENT']
      : ['PAY_FULL'];
    return decide('PAYMENT', 'Complete payment to confirm this enrollment.', completed, actions);
  }
  completed.push('PAYMENT');

  // --- 10. Approval ---------------------------------------------------------
  if (config.enrollment.approval === 'REQUIRED' && context.approval !== 'APPROVED') {
    return decide('AWAITING_APPROVAL', 'Payment received. The club is reviewing your enrollment.', completed, ['CONTACT_CLUB']);
  }
  if (config.enrollment.approval === 'REQUIRED') completed.push('AWAITING_APPROVAL');

  // --- 11. Outstanding instalments -----------------------------------------
  // The membership is ACTIVE at this point; this step exists so the app can
  // keep nudging without implying the player cannot train.
  if (payment?.isPartPayment && payment.outstandingInstalments > 0) {
    return decide(
      'PAYMENT_INSTALMENTS_PENDING',
      `Enrollment is active. ${payment.outstandingInstalments} instalment${payment.outstandingInstalments === 1 ? '' : 's'} still to pay.`,
      completed,
      ['PAY_INSTALMENT'],
    );
  }

  return decide('ACTIVE', 'Enrollment complete.', completed, ['NONE']);
}

function decide(
  step: EnrollmentStep,
  reason: string,
  completed: EnrollmentStep[],
  availableActions: EnrollmentAction[],
): EnrollmentDecision {
  return {
    step,
    reason,
    completed: [...new Set(completed)],
    availableActions,
    terminal: isTerminal(step),
  };
}

// ---------------------------------------------------------------------------
// Action guard
// ---------------------------------------------------------------------------

/**
 * Server-side guard. The client renders `availableActions`, but a client can
 * lie — every mutation endpoint calls this before doing anything.
 */
export function assertActionAllowed(
  context: EnrollmentContext,
  action: EnrollmentAction,
): EnrollmentDecision {
  const decision = resolveEnrollmentStep(context);
  if (!decision.availableActions.includes(action)) {
    throw new EnrollmentTransitionError(action, decision);
  }
  return decision;
}

export class EnrollmentTransitionError extends Error {
  readonly action: EnrollmentAction;
  readonly decision: EnrollmentDecision;

  constructor(action: EnrollmentAction, decision: EnrollmentDecision) {
    super(
      `Action "${action}" is not available at step "${decision.step}". ${decision.reason} Allowed: ${decision.availableActions.join(', ')}.`,
    );
    this.name = 'EnrollmentTransitionError';
    this.action = action;
    this.decision = decision;
  }
}

/**
 * Spec 2.6: the "what happens next" timeline on the post-demo screen. Derived
 * from config so it never promises a step the club has switched off.
 */
export function projectRemainingSteps(config: ClubConfig, from: EnrollmentStep): EnrollmentStep[] {
  const plan: EnrollmentStep[] = [];

  if (config.demo.enabled && config.demo.requiredBeforeEnrollment) {
    plan.push('BOOK_DEMO', 'AWAITING_DEMO', 'AWAITING_DEMO_FEEDBACK', 'POST_DEMO_REVIEW');
  }
  plan.push(
    config.enrollment.batchAssignment === 'COACH_ASSIGNED' ? 'AWAITING_BATCH_ASSIGNMENT' : 'SELECT_BATCH',
  );
  plan.push('SELECT_PACKAGE');
  if (config.enrollment.trialClassEnabled) plan.push('TRIAL_AVAILABLE');
  plan.push('PAYMENT');
  if (config.enrollment.approval === 'REQUIRED') plan.push('AWAITING_APPROVAL');
  plan.push('ACTIVE');

  const index = plan.indexOf(from);
  return index === -1 ? plan : plan.slice(index + 1);
}
