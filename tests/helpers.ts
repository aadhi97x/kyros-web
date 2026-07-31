import { applyConfigPatch, defaultClubConfig, type ClubConfigPatch } from '@/domain/config/engine';
import type { ClubConfig } from '@/domain/config/schema';
import type {
  EnrollmentBatch,
  EnrollmentContext,
  EnrollmentDemo,
  EnrollmentPackage,
  EnrollmentPayment,
  EnrollmentPlayer,
} from '@/domain/enrollment/state-machine';

/** A club config with only the toggles a test cares about overridden. */
export function makeConfig(patch: ClubConfigPatch = {}): ClubConfig {
  return applyConfigPatch(defaultClubConfig(), patch);
}

export function makePlayer(over: Partial<EnrollmentPlayer> = {}): EnrollmentPlayer {
  return {
    id: 'player_1',
    isMinor: false,
    ageYears: 24,
    hasActiveConsent: true,
    ...over,
  };
}

export function makeBatch(over: Partial<EnrollmentBatch> = {}): EnrollmentBatch {
  return {
    id: 'batch_1',
    capacity: 20,
    activeCount: 5,
    minAge: 8,
    maxAge: 40,
    waitlistSize: 0,
    ...over,
  };
}

export function makePackage(over: Partial<EnrollmentPackage> = {}): EnrollmentPackage {
  return {
    id: 'pkg_1',
    batchId: 'batch_1',
    totalPaise: 250_000,
    ...over,
  };
}

export function makeDemo(over: Partial<EnrollmentDemo> = {}): EnrollmentDemo {
  return {
    status: 'COMPLETED',
    feedbackRecorded: true,
    reviewAcknowledged: true,
    recommendedBatchId: 'batch_1',
    recommendedPackageId: 'pkg_1',
    ...over,
  };
}

export function makePayment(over: Partial<EnrollmentPayment> = {}): EnrollmentPayment {
  return {
    paidPaise: 250_000,
    totalPaise: 250_000,
    isPartPayment: false,
    outstandingInstalments: 0,
    ...over,
  };
}

/**
 * A context that, with the default config, resolves straight to ACTIVE.
 * Tests then break exactly one thing, so a failure points at that one thing.
 */
export function makeContext(over: Partial<EnrollmentContext> = {}): EnrollmentContext {
  return {
    config: makeConfig(),
    player: makePlayer(),
    batch: makeBatch(),
    package: makePackage(),
    demo: null,
    payment: makePayment(),
    onWaitlist: false,
    trialUsed: false,
    approval: null,
    waitlistDeclined: false,
    ...over,
  };
}
