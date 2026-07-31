import { describe, expect, it } from 'vitest';
import {
  EnrollmentTransitionError,
  assertActionAllowed,
  batchHasSpace,
  projectRemainingSteps,
  resolveEnrollmentStep,
  waitlistHasRoom,
} from '@/domain/enrollment/state-machine';
import {
  makeBatch,
  makeConfig,
  makeContext,
  makeDemo,
  makePackage,
  makePayment,
  makePlayer,
} from './helpers';

describe('the happy path', () => {
  it('lands on ACTIVE for a fully settled default-config enrollment', () => {
    const decision = resolveEnrollmentStep(makeContext());
    expect(decision.step).toBe('ACTIVE');
    expect(decision.terminal).toBe(true);
  });
});

describe('consent gate (spec 2.3 / 7)', () => {
  it('blocks a minor without consent before anything else', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ player: makePlayer({ isMinor: true, ageYears: 9, hasActiveConsent: false }) }),
    );
    expect(decision.step).toBe('CONSENT_REQUIRED');
    expect(decision.availableActions).toEqual(['GRANT_CONSENT']);
  });

  it('outranks every other gate — a full batch does not change the answer', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        player: makePlayer({ isMinor: true, ageYears: 9, hasActiveConsent: false }),
        batch: makeBatch({ capacity: 10, activeCount: 10 }),
        package: null,
        payment: null,
      }),
    );
    expect(decision.step).toBe('CONSENT_REQUIRED');
  });

  it('lets a consented minor through', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ player: makePlayer({ isMinor: true, ageYears: 9, hasActiveConsent: true }) }),
    );
    expect(decision.step).toBe('ACTIVE');
  });

  it('never asks an adult player for guardian consent', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ player: makePlayer({ isMinor: false, hasActiveConsent: false }) }),
    );
    expect(decision.step).toBe('ACTIVE');
  });
});

describe('demo branch (spec 2.6 / 2.7)', () => {
  const demoConfig = makeConfig({ demo: { enabled: true, requiredBeforeEnrollment: true } });

  it('asks for a demo booking when none exists', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: demoConfig, demo: null, package: null, payment: null }),
    );
    expect(decision.step).toBe('BOOK_DEMO');
  });

  it('waits while the demo is merely confirmed', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: demoConfig, demo: makeDemo({ status: 'CONFIRMED' }) }),
    );
    expect(decision.step).toBe('AWAITING_DEMO');
    expect(decision.availableActions).toContain('CANCEL_DEMO');
  });

  it('waits for the coach to write up a completed demo', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: demoConfig,
        demo: makeDemo({ status: 'COMPLETED', feedbackRecorded: false }),
      }),
    );
    expect(decision.step).toBe('AWAITING_DEMO_FEEDBACK');
  });

  it('shows the post-demo review once feedback lands', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: demoConfig,
        demo: makeDemo({ feedbackRecorded: true, reviewAcknowledged: false }),
      }),
    );
    expect(decision.step).toBe('POST_DEMO_REVIEW');
    expect(decision.availableActions).toEqual(['ACKNOWLEDGE_DEMO_REVIEW']);
  });

  it('sends a cancelled demo back to booking rather than stranding the member', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: demoConfig, demo: makeDemo({ status: 'CANCELLED' }) }),
    );
    expect(decision.step).toBe('BOOK_DEMO');
  });

  it('treats a no-show the same way', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: demoConfig, demo: makeDemo({ status: 'NO_SHOW' }) }),
    );
    expect(decision.step).toBe('BOOK_DEMO');
  });

  it('skips the whole branch when the club has demos off', () => {
    const decision = resolveEnrollmentStep(makeContext({ config: makeConfig(), demo: null }));
    expect(decision.step).toBe('ACTIVE');
  });

  it('does not gate enrollment when demos are offered but not required', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ demo: { enabled: true, requiredBeforeEnrollment: false } }),
        demo: null,
      }),
    );
    expect(decision.step).toBe('ACTIVE');
  });
});

describe('batch assignment branch (spec 2.7)', () => {
  it('asks a self-select member to choose', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ batch: null, package: null, payment: null }),
    );
    expect(decision.step).toBe('SELECT_BATCH');
    expect(decision.availableActions).toEqual(['SELECT_BATCH']);
  });

  it('makes a coach-assigned member wait', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { batchAssignment: 'COACH_ASSIGNED' } }),
        batch: null,
        package: null,
        payment: null,
      }),
    );
    expect(decision.step).toBe('AWAITING_BATCH_ASSIGNMENT');
    expect(decision.availableActions).not.toContain('SELECT_BATCH');
  });

  it('tells a coach-assigned member when a recommendation already exists', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({
          demo: { enabled: true, requiredBeforeEnrollment: true },
          enrollment: { batchAssignment: 'COACH_ASSIGNED' },
        }),
        demo: makeDemo({ recommendedBatchId: 'batch_7' }),
        batch: null,
        package: null,
        payment: null,
      }),
    );
    expect(decision.step).toBe('AWAITING_BATCH_ASSIGNMENT');
    expect(decision.reason).toMatch(/recommended a batch/);
  });
});

describe('age band', () => {
  it('blocks a player outside the band when the club enforces it', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        player: makePlayer({ ageYears: 6 }),
        batch: makeBatch({ minAge: 8, maxAge: 12 }),
      }),
    );
    expect(decision.step).toBe('AGE_BAND_MISMATCH');
    expect(decision.reason).toMatch(/ages 8–12/);
  });

  it('lets a player through inside the tolerance', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { ageBandToleranceYears: 2 } }),
        player: makePlayer({ ageYears: 6 }),
        batch: makeBatch({ minAge: 8, maxAge: 12 }),
      }),
    );
    expect(decision.step).toBe('ACTIVE');
  });

  it('ignores the band entirely when enforcement is off', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { enforceAgeBand: false } }),
        player: makePlayer({ ageYears: 45 }),
        batch: makeBatch({ minAge: 8, maxAge: 12 }),
      }),
    );
    expect(decision.step).toBe('ACTIVE');
  });

  it('offers a self-select member a way out, and a coach-assigned member the club', () => {
    const mismatch = { player: makePlayer({ ageYears: 6 }), batch: makeBatch({ minAge: 8, maxAge: 12 }) };
    expect(resolveEnrollmentStep(makeContext(mismatch)).availableActions).toContain('CHANGE_BATCH');
    expect(
      resolveEnrollmentStep(
        makeContext({
          ...mismatch,
          config: makeConfig({ enrollment: { batchAssignment: 'COACH_ASSIGNED' } }),
        }),
      ).availableActions,
    ).toEqual(['CONTACT_CLUB']);
  });
});

describe('capacity and waitlist (spec 7)', () => {
  const full = makeBatch({ capacity: 10, activeCount: 10 });
  const inFlight = { package: makePackage(), payment: null };

  it('offers the waitlist when the batch is full and the club runs one', () => {
    const decision = resolveEnrollmentStep(makeContext({ batch: full, ...inFlight }));
    expect(decision.step).toBe('OFFER_WAITLIST');
    expect(decision.availableActions).toContain('JOIN_WAITLIST');
  });

  it('blocks outright when the club has no waitlist', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { waitlistEnabled: false } }),
        batch: full,
        ...inFlight,
      }),
    );
    expect(decision.step).toBe('CAPACITY_BLOCKED');
    expect(decision.terminal).toBe(true);
    expect(decision.reason).toMatch(/does not run a waitlist/);
  });

  it('reports WAITLISTED once the member is queued', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ batch: full, onWaitlist: true, ...inFlight }),
    );
    expect(decision.step).toBe('WAITLISTED');
    expect(decision.availableActions).toContain('LEAVE_WAITLIST');
  });

  it('stops re-offering the waitlist once declined', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ batch: full, waitlistDeclined: true, ...inFlight }),
    );
    expect(decision.step).toBe('CAPACITY_BLOCKED');
    expect(decision.reason).toMatch(/declined the waitlist/);
  });

  it('blocks when the waitlist itself is full', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { waitlistMaxSize: 5 } }),
        batch: makeBatch({ capacity: 10, activeCount: 10, waitlistSize: 5 }),
        ...inFlight,
      }),
    );
    expect(decision.step).toBe('CAPACITY_BLOCKED');
    expect(decision.reason).toMatch(/waitlist is also full/);
  });

  it('treats waitlistMaxSize 0 as unlimited', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { waitlistMaxSize: 0 } }),
        batch: makeBatch({ capacity: 10, activeCount: 10, waitlistSize: 900 }),
        ...inFlight,
      }),
    );
    expect(decision.step).toBe('OFFER_WAITLIST');
  });

  it('does not evict an already-paid member when the batch later fills up', () => {
    // Regression guard: capacity is an admission gate, not an ongoing check.
    const decision = resolveEnrollmentStep(
      makeContext({ batch: makeBatch({ capacity: 10, activeCount: 12 }), payment: makePayment() }),
    );
    expect(decision.step).toBe('ACTIVE');
  });

  it('exposes the capacity primitives directly', () => {
    expect(batchHasSpace(makeBatch({ capacity: 10, activeCount: 9 }))).toBe(true);
    expect(batchHasSpace(makeBatch({ capacity: 10, activeCount: 10 }))).toBe(false);
    expect(waitlistHasRoom(makeConfig({ enrollment: { waitlistEnabled: false } }), full)).toBe(false);
  });
});

describe('package selection', () => {
  it('asks for a package once the batch is settled', () => {
    const decision = resolveEnrollmentStep(makeContext({ package: null, payment: null }));
    expect(decision.step).toBe('SELECT_PACKAGE');
  });
});

describe('trial branch', () => {
  const trialConfig = makeConfig({ enrollment: { trialClassEnabled: true } });

  it('offers the trial before asking for money', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: trialConfig, payment: null, trialUsed: false }),
    );
    expect(decision.step).toBe('TRIAL_AVAILABLE');
    expect(decision.availableActions).toEqual(expect.arrayContaining(['START_TRIAL', 'SKIP_TRIAL', 'PAY_FULL']));
  });

  it('moves on once the trial is used', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: trialConfig, payment: null, trialUsed: true }),
    );
    expect(decision.step).toBe('PAYMENT');
  });

  it('pluralises the trial count correctly', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ enrollment: { trialClassEnabled: true, trialClassCount: 3 } }),
        payment: null,
      }),
    );
    expect(decision.reason).toMatch(/3 trial classes/);
  });

  it('is skipped entirely when the club has trials off', () => {
    const decision = resolveEnrollmentStep(makeContext({ payment: null }));
    expect(decision.step).toBe('PAYMENT');
  });
});

describe('payment branch (spec 2.8)', () => {
  it('asks for payment when nothing has been paid', () => {
    const decision = resolveEnrollmentStep(makeContext({ payment: null }));
    expect(decision.step).toBe('PAYMENT');
    expect(decision.availableActions).toEqual(['PAY_FULL']);
  });

  it('offers instalments only when the club allows part payment', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ payments: { partPaymentAllowed: true } }),
        payment: null,
      }),
    );
    expect(decision.availableActions).toContain('PAY_INSTALMENT');
  });

  it('holds at PAYMENT when a full payment is only partly settled', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ payment: makePayment({ paidPaise: 100_000, totalPaise: 250_000 }) }),
    );
    expect(decision.step).toBe('PAYMENT');
  });

  it('activates a part payment on the first instalment and keeps nudging', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ payments: { partPaymentAllowed: true } }),
        payment: makePayment({
          paidPaise: 125_000,
          totalPaise: 250_000,
          isPartPayment: true,
          outstandingInstalments: 1,
        }),
      }),
    );
    expect(decision.step).toBe('PAYMENT_INSTALMENTS_PENDING');
    expect(decision.reason).toMatch(/1 instalment still to pay/);
    expect(decision.terminal).toBe(false);
  });

  it('reaches ACTIVE once the last instalment clears', () => {
    const decision = resolveEnrollmentStep(
      makeContext({
        config: makeConfig({ payments: { partPaymentAllowed: true } }),
        payment: makePayment({ isPartPayment: true, outstandingInstalments: 0 }),
      }),
    );
    expect(decision.step).toBe('ACTIVE');
  });
});

describe('approval branch (spec 2.7)', () => {
  const approvalConfig = makeConfig({ enrollment: { approval: 'REQUIRED' } });

  it('holds a paid enrollment for club review', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: approvalConfig, approval: 'PENDING' }),
    );
    expect(decision.step).toBe('AWAITING_APPROVAL');
  });

  it('holds even when approval has not been recorded at all yet', () => {
    const decision = resolveEnrollmentStep(makeContext({ config: approvalConfig, approval: null }));
    expect(decision.step).toBe('AWAITING_APPROVAL');
  });

  it('activates once approved', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: approvalConfig, approval: 'APPROVED' }),
    );
    expect(decision.step).toBe('ACTIVE');
  });

  it('is terminal on rejection, whatever else is true', () => {
    const decision = resolveEnrollmentStep(
      makeContext({ config: approvalConfig, approval: 'REJECTED' }),
    );
    expect(decision.step).toBe('REJECTED');
    expect(decision.terminal).toBe(true);
  });

  it('auto-confirms when the club does not gate on approval', () => {
    const decision = resolveEnrollmentStep(makeContext({ approval: null }));
    expect(decision.step).toBe('ACTIVE');
  });
});

describe('determinism and idempotence', () => {
  it('returns the same decision for the same context every time', () => {
    const context = makeContext({ payment: null });
    const first = resolveEnrollmentStep(context);
    const second = resolveEnrollmentStep(context);
    expect(first).toEqual(second);
  });

  it('does not mutate the context it is given', () => {
    const context = makeContext({ payment: null });
    const before = JSON.stringify(context);
    resolveEnrollmentStep(context);
    expect(JSON.stringify(context)).toBe(before);
  });

  it('reflects a mid-flight config change on the next evaluation', () => {
    const base = makeContext({ batch: makeBatch({ capacity: 5, activeCount: 5 }), payment: null });
    expect(resolveEnrollmentStep(base).step).toBe('OFFER_WAITLIST');

    const afterOwnerTurnsWaitlistOff = {
      ...base,
      config: makeConfig({ enrollment: { waitlistEnabled: false } }),
    };
    expect(resolveEnrollmentStep(afterOwnerTurnsWaitlistOff).step).toBe('CAPACITY_BLOCKED');
  });
});

describe('the full gauntlet — every gate on at once', () => {
  const strictest = makeConfig({
    demo: { enabled: true, requiredBeforeEnrollment: true },
    enrollment: {
      batchAssignment: 'COACH_ASSIGNED',
      approval: 'REQUIRED',
      trialClassEnabled: true,
      waitlistEnabled: true,
    },
    payments: { partPaymentAllowed: true },
  });

  it('walks a minor through consent → demo → placement → trial → payment → approval', () => {
    let context = makeContext({
      config: strictest,
      player: makePlayer({ isMinor: true, ageYears: 10, hasActiveConsent: false }),
      batch: null,
      package: null,
      payment: null,
      demo: null,
      approval: null,
    });
    expect(resolveEnrollmentStep(context).step).toBe('CONSENT_REQUIRED');

    context = { ...context, player: makePlayer({ isMinor: true, ageYears: 10, hasActiveConsent: true }) };
    expect(resolveEnrollmentStep(context).step).toBe('BOOK_DEMO');

    context = { ...context, demo: makeDemo({ status: 'CONFIRMED', feedbackRecorded: false, reviewAcknowledged: false }) };
    expect(resolveEnrollmentStep(context).step).toBe('AWAITING_DEMO');

    context = { ...context, demo: makeDemo({ status: 'COMPLETED', feedbackRecorded: false, reviewAcknowledged: false }) };
    expect(resolveEnrollmentStep(context).step).toBe('AWAITING_DEMO_FEEDBACK');

    context = { ...context, demo: makeDemo({ reviewAcknowledged: false }) };
    expect(resolveEnrollmentStep(context).step).toBe('POST_DEMO_REVIEW');

    context = { ...context, demo: makeDemo() };
    expect(resolveEnrollmentStep(context).step).toBe('AWAITING_BATCH_ASSIGNMENT');

    context = { ...context, batch: makeBatch({ minAge: 8, maxAge: 12 }) };
    expect(resolveEnrollmentStep(context).step).toBe('SELECT_PACKAGE');

    context = { ...context, package: makePackage() };
    expect(resolveEnrollmentStep(context).step).toBe('TRIAL_AVAILABLE');

    context = { ...context, trialUsed: true };
    expect(resolveEnrollmentStep(context).step).toBe('PAYMENT');

    context = {
      ...context,
      payment: makePayment({ paidPaise: 125_000, isPartPayment: true, outstandingInstalments: 1 }),
    };
    expect(resolveEnrollmentStep(context).step).toBe('AWAITING_APPROVAL');

    context = { ...context, approval: 'APPROVED' };
    expect(resolveEnrollmentStep(context).step).toBe('PAYMENT_INSTALMENTS_PENDING');

    context = { ...context, payment: makePayment({ isPartPayment: true, outstandingInstalments: 0 }) };
    expect(resolveEnrollmentStep(context).step).toBe('ACTIVE');
  });

  it('reaches ACTIVE in one hop for the most permissive club', () => {
    expect(resolveEnrollmentStep(makeContext()).step).toBe('ACTIVE');
  });
});

describe('server-side action guard', () => {
  it('permits an action the current step offers', () => {
    const context = makeContext({ payment: null });
    expect(() => assertActionAllowed(context, 'PAY_FULL')).not.toThrow();
  });

  it('rejects an action from a different step', () => {
    const context = makeContext({ payment: null });
    expect(() => assertActionAllowed(context, 'JOIN_WAITLIST')).toThrow(EnrollmentTransitionError);
  });

  it('refuses to let a client skip the consent gate', () => {
    const context = makeContext({
      player: makePlayer({ isMinor: true, hasActiveConsent: false }),
      payment: null,
    });
    expect(() => assertActionAllowed(context, 'PAY_FULL')).toThrow(/not available at step/);
  });

  it('explains what was allowed instead', () => {
    try {
      assertActionAllowed(makeContext({ payment: null }), 'JOIN_WAITLIST');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnrollmentTransitionError).decision.step).toBe('PAYMENT');
      expect((error as Error).message).toMatch(/Allowed: PAY_FULL/);
    }
  });
});

describe('"what happens next" projection (spec 2.6)', () => {
  it('never promises a step the club has switched off', () => {
    const plan = projectRemainingSteps(makeConfig(), 'SELECT_BATCH');
    expect(plan).not.toContain('BOOK_DEMO');
    expect(plan).not.toContain('TRIAL_AVAILABLE');
    expect(plan).not.toContain('AWAITING_APPROVAL');
    expect(plan.at(-1)).toBe('ACTIVE');
  });

  it('includes every gate the club does run', () => {
    const config = makeConfig({
      demo: { enabled: true, requiredBeforeEnrollment: true },
      enrollment: { trialClassEnabled: true, approval: 'REQUIRED' },
    });
    const plan = projectRemainingSteps(config, 'POST_DEMO_REVIEW');
    expect(plan).toEqual(['SELECT_BATCH', 'SELECT_PACKAGE', 'TRIAL_AVAILABLE', 'PAYMENT', 'AWAITING_APPROVAL', 'ACTIVE']);
  });

  it('returns the whole plan for a step that is not on it', () => {
    const plan = projectRemainingSteps(makeConfig(), 'CAPACITY_BLOCKED');
    expect(plan[0]).toBe('SELECT_BATCH');
  });
});
