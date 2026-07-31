/**
 * The club configuration engine.
 *
 * Parse, normalise, merge, migrate and query a club's config. Every read of a
 * club config anywhere in the codebase goes through `parseClubConfig` — nothing
 * else may cast `club.config` and hope for the best, because a config written
 * by an older build must still produce correct behaviour today.
 *
 * Pure module: no I/O, no framework imports.
 */

import { z } from 'zod';
import {
  CLUB_CONFIG_VERSION,
  clubConfigSchema,
  type ClubConfig,
  type ClubConfigInput,
} from './schema';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClubConfigError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[] = []) {
    super(message);
    this.name = 'ClubConfigError';
    this.issues = issues;
  }

  /** Field-path -> message, shaped for the wizard's inline errors. */
  toFieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) {
      const key = issue.path.join('.') || '_';
      if (!(key in out)) out[key] = issue.message;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The config a brand-new club starts with, before the owner touches the wizard.
 * Deliberately the most permissive-but-safe posture: no demo gate, no approval
 * gate, waitlist on, chat on, pauses allowed.
 */
export function defaultClubConfig(): ClubConfig {
  // Normalised, so that `defaultClubConfig()` is byte-identical to what
  // `parseClubConfig(null)` returns and to what gets written to the database.
  // An un-normalised default would make round-trip comparisons fail in
  // confusing ways.
  return normalise(clubConfigSchema.parse({}));
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

type Migration = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * Ordered migrations keyed by the version they upgrade FROM.
 *
 * When you add a toggle:
 *   1. add it to the schema with a default,
 *   2. bump CLUB_CONFIG_VERSION,
 *   3. add an entry here that rewrites v(N) into v(N+1).
 *
 * Never reinterpret an existing field in place — old rows are already on disk.
 */
const migrations: Record<number, Migration> = {
  // 1: (config) => ({ ...config, version: 2, newSection: { ... } }),
};

function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  let version = typeof current.version === 'number' ? current.version : 0;

  // A config with no version predates versioning; treat it as v1 shaped and let
  // the schema defaults fill the gaps.
  if (version === 0) {
    current = { ...current, version: 1 };
    version = 1;
  }

  while (version < CLUB_CONFIG_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new ClubConfigError(
        `No migration registered from club config version ${version} to ${version + 1}.`,
      );
    }
    current = step(current);
    const next = typeof current.version === 'number' ? current.version : version + 1;
    if (next <= version) {
      throw new ClubConfigError(
        `Migration from version ${version} did not advance the version field.`,
      );
    }
    version = next;
  }

  return current;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Resolve combinations that are valid but internally contradictory, so that
 * every consumer sees one canonical truth rather than each re-deriving it.
 *
 * Example: an owner turns chat off entirely but the batch-chat toggle is still
 * true underneath. Reading `batchChatEnabled` directly would render a chat tab
 * that leads nowhere. After normalisation the child toggles agree with the
 * master switch.
 */
function normalise(config: ClubConfig): ClubConfig {
  const next: ClubConfig = structuredClone(config);

  // Chat master switch wins over the child toggles.
  if (!next.communication.chatEnabled) {
    next.communication.batchChatEnabled = false;
    next.communication.directChatEnabled = false;
  }

  // A disabled waitlist has no size.
  if (!next.enrollment.waitlistEnabled) {
    next.enrollment.waitlistMaxSize = 0;
  }

  // Demos off ⇒ nothing demo-related applies.
  if (!next.demo.enabled) {
    next.demo.requiredBeforeEnrollment = false;
    next.demo.feePaise = 0;
  }

  // Part payment off ⇒ a single, full payment.
  if (!next.payments.partPaymentAllowed) {
    next.payments.partPaymentSplits = 2;
    next.payments.partPaymentUpfrontBps = 10000;
  }

  // Pauses disallowed ⇒ the pause rules are inert. Zero them so no UI shows a
  // "60 days per year" allowance that the club will refuse.
  if (!next.pause.allowed) {
    next.pause.maxDaysPerYear = 0;
    next.pause.acceptedReasons = [];
  }

  // Carryover NEITHER ⇒ a pause cannot produce credit.
  if (next.refunds.carryover === 'NEITHER') {
    // Nothing to zero on the config itself; the lifecycle engine reads the
    // policy directly. Kept explicit so the intent is not lost.
  }

  // Reminder days: dedupe and sort descending so scheduling is deterministic.
  next.payments.instalmentReminderDaysBefore = Array.from(
    new Set(next.payments.instalmentReminderDaysBefore),
  ).sort((a, b) => b - a);

  return next;
}

// ---------------------------------------------------------------------------
// Build-support gate
// ---------------------------------------------------------------------------

/**
 * Spec 3.2 marks coach-tap as the only attendance method in this build, while
 * spec 4.3 describes the face-gate future. The enum models all three so no
 * migration is needed later; this gate stops a club selecting a method the
 * build cannot actually service.
 */
const SUPPORTED_ATTENDANCE_METHODS = new Set<ClubConfig['attendance']['method']>(['COACH_TAP']);

export function assertBuildSupported(config: ClubConfig): void {
  if (!SUPPORTED_ATTENDANCE_METHODS.has(config.attendance.method)) {
    throw new ClubConfigError(
      `Attendance method "${config.attendance.method}" is modelled but not available in this build. Use COACH_TAP.`,
      [
        {
          code: z.ZodIssueCode.custom,
          path: ['attendance', 'method'],
          message: 'Only COACH_TAP is available in this build.',
        },
      ],
    );
  }

  if (config.privacy.childProfilingEnabled !== false) {
    throw new ClubConfigError('Child profiling can never be enabled.', [
      {
        code: z.ZodIssueCode.custom,
        path: ['privacy', 'childProfilingEnabled'],
        message: 'Profiling of minors is prohibited.',
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The single entry point for turning a stored `club.config` JSON blob into a
 * usable, canonical `ClubConfig`.
 *
 * @throws ClubConfigError when the stored value cannot be migrated or parsed.
 */
export function parseClubConfig(raw: unknown): ClubConfig {
  if (raw === null || raw === undefined) {
    return normalise(defaultClubConfig());
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClubConfigError('Club config must be a JSON object.');
  }

  const migrated = migrate(raw as Record<string, unknown>);
  const result = clubConfigSchema.safeParse(migrated);

  if (!result.success) {
    // Surface the actual problems in the message. A generic "validation failed"
    // sends whoever hits this straight to the debugger to find out what broke.
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ClubConfigError(`Club config failed validation. ${summary}`, result.error.issues);
  }

  return normalise(result.data);
}

/**
 * Lenient variant for read paths that must never hard-fail — the public
 * catalog, for instance, should not 500 because one club has a bad config.
 * Falls back to defaults and reports the problem to the caller.
 */
export function parseClubConfigSafe(raw: unknown): {
  config: ClubConfig;
  ok: boolean;
  error?: ClubConfigError;
} {
  try {
    return { config: parseClubConfig(raw), ok: true };
  } catch (error) {
    const configError =
      error instanceof ClubConfigError
        ? error
        : new ClubConfigError('Unknown club config failure.');
    return { config: normalise(defaultClubConfig()), ok: false, error: configError };
  }
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export type ClubConfigPatch = DeepPartial<ClubConfigInput>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value)
      ? deepMerge(existing, value)
      : value;
  }
  return out;
}

/**
 * Toggles that control other toggles. When a patch switches a parent OFF, any
 * dependent left over from a previous setting is stale rather than
 * contradictory, so it is cleared instead of rejected.
 *
 * The distinction matters: submitting `{enabled: false, required: true}` in one
 * payload is a contradiction the owner should be told about, but *editing* a
 * config to turn demos off should not throw an error about a flag the owner set
 * three steps ago and can no longer see.
 */
interface DependentRule {
  section: string;
  key: string;
  /** Value to write when the parent is switched off. */
  onDisable?: unknown;
  /**
   * Value to write when the parent is switched back on. Needed because
   * `normalise` parks dependents at a sentinel while the parent is off, and
   * that sentinel must not survive re-enabling.
   */
  onEnable?: unknown;
}

const DEPENDENT_TOGGLES: ReadonlyArray<{
  section: string;
  parent: string;
  dependents: ReadonlyArray<DependentRule>;
}> = [
  {
    section: 'demo',
    parent: 'enabled',
    dependents: [{ section: 'demo', key: 'requiredBeforeEnrollment', onDisable: false }],
  },
  {
    section: 'communication',
    parent: 'chatEnabled',
    dependents: [
      { section: 'communication', key: 'batchChatEnabled', onDisable: false, onEnable: true },
      { section: 'communication', key: 'directChatEnabled', onDisable: false },
    ],
  },
  {
    section: 'payments',
    parent: 'partPaymentAllowed',
    dependents: [
      // Parked at 100% (a single full payment) while off; back to the schema
      // default when the owner re-enables instalments.
      { section: 'payments', key: 'partPaymentUpfrontBps', onDisable: 10000, onEnable: 5000 },
    ],
  },
  {
    section: 'pause',
    parent: 'allowed',
    dependents: [
      { section: 'pause', key: 'maxDaysPerYear', onDisable: 0, onEnable: 60 },
      { section: 'pause', key: 'acceptedReasons', onDisable: [], onEnable: ['INJURY', 'ILLNESS'] },
    ],
  },
  {
    section: 'enrollment',
    parent: 'waitlistEnabled',
    dependents: [{ section: 'enrollment', key: 'waitlistMaxSize', onDisable: 0, onEnable: 50 }],
  },
];

/**
 * Reconcile dependent toggles against a parent this patch just flipped.
 *
 * An explicit value for the dependent in the SAME patch is the owner's stated
 * intent and is left alone, so a genuine contradiction still surfaces as a
 * validation error rather than being silently rewritten.
 */
function reconcileDependents(
  merged: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const rule of DEPENDENT_TOGGLES) {
    const patchSection = patch[rule.section];
    if (!isPlainObject(patchSection)) continue;

    const flipped = patchSection[rule.parent];
    if (flipped !== true && flipped !== false) continue;

    for (const dependent of rule.dependents) {
      const patchDependentSection = patch[dependent.section];
      if (isPlainObject(patchDependentSection) && dependent.key in patchDependentSection) continue;

      const replacement = flipped ? dependent.onEnable : dependent.onDisable;
      if (replacement === undefined) continue;

      const mergedSection = merged[dependent.section];
      if (isPlainObject(mergedSection)) {
        mergedSection[dependent.key] = replacement;
      }
    }
  }
}

/**
 * Apply a partial update from one wizard step without disturbing the rest.
 * Re-validates the whole object — a step edit can invalidate a combination set
 * three steps earlier, and the owner needs to hear about it now.
 */
export function applyConfigPatch(current: ClubConfig, patch: ClubConfigPatch): ClubConfig {
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
  );
  reconcileDependents(merged, patch as Record<string, unknown>);
  // Version is owned by the engine, never by the caller.
  merged.version = CLUB_CONFIG_VERSION;
  return parseClubConfig(merged);
}

/** Serialise for storage in the `Json` column. */
export function serialiseClubConfig(config: ClubConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime queries — what the member app actually asks
// ---------------------------------------------------------------------------

/**
 * The subset of config the member app needs to render a club correctly. Sent
 * with club and package payloads so the client can branch without a second
 * round trip, and so nothing club-internal (policy thresholds, absentee rules)
 * leaks to members who have no use for it.
 */
export interface MemberFacingConfig {
  demoEnabled: boolean;
  demoFeePaise: number;
  demoRequiredBeforeEnrollment: boolean;
  demoBookingWindowDays: number;
  demoMinNoticeHours: number;
  batchAssignment: ClubConfig['enrollment']['batchAssignment'];
  memberPicksBatch: boolean;
  approvalRequired: boolean;
  trialClassEnabled: boolean;
  trialClassCount: number;
  waitlistEnabled: boolean;
  partPaymentAllowed: boolean;
  partPaymentSplits: number;
  partPaymentUpfrontBps: number;
  chatEnabled: boolean;
  batchChatEnabled: boolean;
  directChatEnabled: boolean;
  pauseAllowed: boolean;
  pauseMinDays: number;
  pauseMaxDaysPerYear: number;
  pauseNoticeDays: number;
  pauseAcceptedReasons: ClubConfig['pause']['acceptedReasons'];
  carryover: ClubConfig['refunds']['carryover'];
  refundIfNeverAttended: boolean;
  neverAttendedWindowDays: number;
  cancellationNoticeDays: number;
  registrationFeeRefundable: boolean;
  parentVerificationMethod: ClubConfig['privacy']['parentVerificationMethod'];
}

export function toMemberFacingConfig(config: ClubConfig): MemberFacingConfig {
  return {
    demoEnabled: config.demo.enabled,
    demoFeePaise: config.demo.feePaise,
    demoRequiredBeforeEnrollment: config.demo.requiredBeforeEnrollment,
    demoBookingWindowDays: config.demo.bookingWindowDays,
    demoMinNoticeHours: config.demo.minNoticeHours,
    batchAssignment: config.enrollment.batchAssignment,
    memberPicksBatch: config.enrollment.batchAssignment === 'MEMBER_SELF_SELECT',
    approvalRequired: config.enrollment.approval === 'REQUIRED',
    trialClassEnabled: config.enrollment.trialClassEnabled,
    trialClassCount: config.enrollment.trialClassCount,
    waitlistEnabled: config.enrollment.waitlistEnabled,
    partPaymentAllowed: config.payments.partPaymentAllowed,
    partPaymentSplits: config.payments.partPaymentSplits,
    partPaymentUpfrontBps: config.payments.partPaymentUpfrontBps,
    chatEnabled: config.communication.chatEnabled,
    batchChatEnabled: config.communication.batchChatEnabled,
    directChatEnabled: config.communication.directChatEnabled,
    pauseAllowed: config.pause.allowed,
    pauseMinDays: config.pause.minDays,
    pauseMaxDaysPerYear: config.pause.maxDaysPerYear,
    pauseNoticeDays: config.pause.noticeDays,
    pauseAcceptedReasons: config.pause.acceptedReasons,
    carryover: config.refunds.carryover,
    refundIfNeverAttended: config.refunds.refundIfNeverAttended,
    neverAttendedWindowDays: config.refunds.neverAttendedWindowDays,
    cancellationNoticeDays: config.refunds.cancellationNoticeDays,
    registrationFeeRefundable: config.refunds.registrationFeeRefundable,
    parentVerificationMethod: config.privacy.parentVerificationMethod,
  };
}

/**
 * Spec 2.5: the package detail page's primary button is dynamic.
 * This is the one place that decides what it says.
 */
export function primaryCallToAction(config: ClubConfig): 'BOOK_DEMO' | 'START_TRIAL' | 'ENROLL' {
  if (config.demo.enabled) return 'BOOK_DEMO';
  if (config.enrollment.trialClassEnabled) return 'START_TRIAL';
  return 'ENROLL';
}

/** Spec 3.7: how many misses trigger the absentee follow-up list. */
export function absenteeThreshold(config: ClubConfig): { misses: number; lookbackDays: number } {
  return {
    misses: config.attendance.absenteeFollowUpAfterMisses,
    lookbackDays: config.attendance.absenteeLookbackDays,
  };
}

/**
 * A human-readable summary of the club's operating rules, for the wizard's
 * review step and for the member-facing "how this club works" panel.
 */
export function describeConfig(config: ClubConfig): string[] {
  const lines: string[] = [];

  lines.push(
    config.demo.enabled
      ? `Demo sessions are offered${config.demo.requiredBeforeEnrollment ? ' and are required before enrolling' : ''}${
          config.demo.feePaise > 0 ? ` (₹${(config.demo.feePaise / 100).toFixed(2)})` : ' (free)'
        }.`
      : 'Members enroll directly — no demo session.',
  );

  lines.push(
    config.enrollment.batchAssignment === 'MEMBER_SELF_SELECT'
      ? 'Members choose their own batch.'
      : 'A coach assigns the batch after reviewing the player.',
  );

  lines.push(
    config.enrollment.approval === 'REQUIRED'
      ? 'Enrollments need club approval before they activate.'
      : 'Enrollments activate automatically once payment succeeds.',
  );

  lines.push(
    config.enrollment.waitlistEnabled
      ? `Full batches offer a waitlist${
          config.enrollment.waitlistMaxSize > 0 ? ` (up to ${config.enrollment.waitlistMaxSize} places)` : ''
        }.`
      : 'Full batches are closed — no waitlist.',
  );

  lines.push(
    config.payments.partPaymentAllowed
      ? `Fees may be split into ${config.payments.partPaymentSplits} instalments, ${config.payments.partPaymentGapDays} days apart.`
      : 'Fees are payable in full.',
  );

  lines.push(
    config.pause.allowed
      ? `Memberships can be paused for ${config.pause.minDays}–${config.pause.maxDaysPerYear} days a year with ${config.pause.noticeDays} days' notice.`
      : 'Memberships cannot be paused.',
  );

  const carryoverText: Record<ClubConfig['refunds']['carryover'], string> = {
    CARRYOVER_CREDIT: 'Unused time becomes wallet credit.',
    ADJUST_NEXT_MONTH: 'Unused time is adjusted against the next month.',
    NEITHER: 'Unused time is not carried over.',
  };
  lines.push(carryoverText[config.refunds.carryover]);

  lines.push(
    config.refunds.refundIfNeverAttended
      ? `Refundable within ${config.refunds.neverAttendedWindowDays} days if the player never attended.`
      : 'No refund once enrolled, even if the player never attended.',
  );

  lines.push(`Cancellation requires ${config.refunds.cancellationNoticeDays} days' notice.`);

  lines.push(
    config.communication.chatEnabled
      ? `Chat is on${config.communication.batchChatEnabled ? ' (batch groups)' : ''}${
          config.communication.directChatEnabled ? ' with direct messages to the club' : ''
        }.`
      : 'Chat is switched off for this club.',
  );

  return lines;
}
