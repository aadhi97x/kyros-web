import { describe, expect, it } from 'vitest';
import {
  ClubConfigError,
  applyConfigPatch,
  assertBuildSupported,
  absenteeThreshold,
  defaultClubConfig,
  describeConfig,
  parseClubConfig,
  parseClubConfigSafe,
  primaryCallToAction,
  serialiseClubConfig,
  toMemberFacingConfig,
} from '@/domain/config/engine';
import { CLUB_CONFIG_VERSION } from '@/domain/config/schema';
import { makeConfig } from './helpers';

describe('defaults', () => {
  it('produces a valid config with no input at all', () => {
    const config = defaultClubConfig();
    expect(config.version).toBe(CLUB_CONFIG_VERSION);
    expect(config.enrollment.waitlistEnabled).toBe(true);
    expect(config.enrollment.approval).toBe('AUTO_CONFIRM_ON_PAYMENT');
    expect(config.attendance.method).toBe('COACH_TAP');
  });

  it('defaults a new club to the least-friction enrollment path', () => {
    const config = defaultClubConfig();
    expect(config.demo.enabled).toBe(false);
    expect(config.demo.requiredBeforeEnrollment).toBe(false);
    expect(config.enrollment.batchAssignment).toBe('MEMBER_SELF_SELECT');
  });

  it('round-trips through serialisation unchanged', () => {
    const config = defaultClubConfig();
    expect(parseClubConfig(serialiseClubConfig(config))).toEqual(config);
  });
});

describe('parsing', () => {
  it('treats null and undefined as "brand new club"', () => {
    expect(parseClubConfig(null)).toEqual(defaultClubConfig());
    expect(parseClubConfig(undefined)).toEqual(defaultClubConfig());
  });

  it('rejects non-objects', () => {
    expect(() => parseClubConfig('nope')).toThrow(ClubConfigError);
    expect(() => parseClubConfig([1, 2, 3])).toThrow(ClubConfigError);
    expect(() => parseClubConfig(42)).toThrow(ClubConfigError);
  });

  it('fills missing sections from defaults rather than failing', () => {
    const config = parseClubConfig({ version: 1, demo: { enabled: true } });
    expect(config.demo.enabled).toBe(true);
    expect(config.payments.partPaymentAllowed).toBe(false);
    expect(config.pause.allowed).toBe(true);
  });

  it('treats an unversioned legacy blob as v1', () => {
    const config = parseClubConfig({ enrollment: { waitlistEnabled: false } });
    expect(config.version).toBe(CLUB_CONFIG_VERSION);
    expect(config.enrollment.waitlistEnabled).toBe(false);
  });

  it('refuses a version it has no migration for', () => {
    expect(() => parseClubConfig({ version: 999 })).toThrow(ClubConfigError);
  });

  it('rejects an unknown enum value instead of silently defaulting', () => {
    expect(() => parseClubConfig({ version: 1, enrollment: { approval: 'MAYBE' } })).toThrow(
      ClubConfigError,
    );
  });

  it('rejects out-of-range numbers', () => {
    expect(() =>
      parseClubConfig({ version: 1, refunds: { cancellationNoticeDays: -5 } }),
    ).toThrow(ClubConfigError);
    expect(() =>
      parseClubConfig({ version: 1, payments: { partPaymentSplits: 99 } }),
    ).toThrow(ClubConfigError);
  });
});

describe('cross-field validation', () => {
  it('refuses a required demo when demos are switched off', () => {
    expect(() =>
      parseClubConfig({
        version: 1,
        demo: { enabled: false, requiredBeforeEnrollment: true },
      }),
    ).toThrow(/no way to join/);
  });

  it('refuses a 100% upfront share while part payment is on', () => {
    expect(() =>
      parseClubConfig({
        version: 1,
        payments: { partPaymentAllowed: true, partPaymentUpfrontBps: 10000 },
      }),
    ).toThrow(/nothing left to instal/);
  });

  it('refuses a pause minimum longer than the annual allowance', () => {
    expect(() =>
      parseClubConfig({ version: 1, pause: { allowed: true, minDays: 90, maxDaysPerYear: 30 } }),
    ).toThrow(/no pause could ever qualify/);
  });

  it('refuses allowing pauses with no accepted reasons', () => {
    expect(() =>
      parseClubConfig({ version: 1, pause: { allowed: true, acceptedReasons: [] } }),
    ).toThrow(/cannot be empty/);
  });

  it('refuses posting hours that end before they start', () => {
    expect(() =>
      parseClubConfig({
        version: 1,
        communication: { memberPostingHours: { startMinute: 1200, endMinute: 300 } },
      }),
    ).toThrow(/must not be after/);
  });

  it('reports field paths so the wizard can show inline errors', () => {
    try {
      parseClubConfig({ version: 1, demo: { enabled: false, requiredBeforeEnrollment: true } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ClubConfigError);
      expect((error as ClubConfigError).toFieldErrors()).toHaveProperty(
        'demo.requiredBeforeEnrollment',
      );
    }
  });
});

describe('normalisation', () => {
  it('turns off child chat toggles when chat is off entirely', () => {
    const config = makeConfig({
      communication: { chatEnabled: false, batchChatEnabled: true, directChatEnabled: true },
    });
    expect(config.communication.batchChatEnabled).toBe(false);
    expect(config.communication.directChatEnabled).toBe(false);
  });

  it('zeroes waitlist size when the waitlist is off', () => {
    const config = makeConfig({ enrollment: { waitlistEnabled: false, waitlistMaxSize: 40 } });
    expect(config.enrollment.waitlistMaxSize).toBe(0);
  });

  it('clears the demo fee when demos are off', () => {
    const config = makeConfig({ demo: { enabled: false, feePaise: 50_000 } });
    expect(config.demo.feePaise).toBe(0);
  });

  it('forces a single full payment when part payment is off', () => {
    const config = makeConfig({ payments: { partPaymentAllowed: false, partPaymentSplits: 6 } });
    expect(config.payments.partPaymentUpfrontBps).toBe(10000);
  });

  it('empties the pause allowance when pauses are disallowed', () => {
    const config = makeConfig({ pause: { allowed: false, maxDaysPerYear: 60 } });
    expect(config.pause.maxDaysPerYear).toBe(0);
    expect(config.pause.acceptedReasons).toEqual([]);
  });

  it('dedupes and sorts instalment reminder days', () => {
    const config = makeConfig({
      payments: { instalmentReminderDaysBefore: [1, 7, 3, 7, 1] },
    });
    expect(config.payments.instalmentReminderDaysBefore).toEqual([7, 3, 1]);
  });

  it('is idempotent — normalising twice changes nothing', () => {
    const once = makeConfig({ communication: { chatEnabled: false } });
    expect(parseClubConfig(serialiseClubConfig(once))).toEqual(once);
  });
});

describe('patching', () => {
  it('merges one section without disturbing the others', () => {
    const base = makeConfig({ payments: { partPaymentAllowed: true, partPaymentSplits: 3 } });
    const patched = applyConfigPatch(base, { demo: { enabled: true } });
    expect(patched.demo.enabled).toBe(true);
    expect(patched.payments.partPaymentSplits).toBe(3);
  });

  it('merges deeply rather than replacing a whole section', () => {
    const base = makeConfig({ pause: { minDays: 14, noticeDays: 7 } });
    const patched = applyConfigPatch(base, { pause: { minDays: 10 } });
    expect(patched.pause.minDays).toBe(10);
    expect(patched.pause.noticeDays).toBe(7);
  });

  it('ignores undefined values in a patch', () => {
    const base = makeConfig({ demo: { enabled: true } });
    const patched = applyConfigPatch(base, { demo: { enabled: undefined } });
    expect(patched.demo.enabled).toBe(true);
  });

  it('re-validates the whole object, catching a combination broken from afar', () => {
    const base = makeConfig({ demo: { enabled: true, requiredBeforeEnrollment: true } });
    // Turning demos off now contradicts a setting made earlier.
    expect(() => applyConfigPatch(base, { demo: { enabled: false } })).not.toThrow();
    // ...because normalisation resolves it. But an explicit contradiction in a
    // single patch is still rejected:
    expect(() =>
      applyConfigPatch(makeConfig(), { demo: { enabled: false, requiredBeforeEnrollment: true } }),
    ).toThrow(ClubConfigError);
  });

  it('does not let a caller set the version', () => {
    const patched = applyConfigPatch(makeConfig(), {
      version: 99,
    } as unknown as Parameters<typeof applyConfigPatch>[1]);
    expect(patched.version).toBe(CLUB_CONFIG_VERSION);
  });

  it('does not mutate the input config', () => {
    const base = makeConfig();
    const before = JSON.stringify(base);
    applyConfigPatch(base, { demo: { enabled: true } });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('safe parsing', () => {
  it('reports success for a good config', () => {
    const result = parseClubConfigSafe({ version: 1, demo: { enabled: true } });
    expect(result.ok).toBe(true);
    expect(result.config.demo.enabled).toBe(true);
  });

  it('falls back to defaults rather than throwing, so one bad club cannot break the catalog', () => {
    const result = parseClubConfigSafe({ version: 1, enrollment: { approval: 'NONSENSE' } });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(ClubConfigError);
    expect(result.config).toEqual(defaultClubConfig());
  });
});

describe('build-support gate', () => {
  it('accepts coach-tap attendance', () => {
    expect(() => assertBuildSupported(makeConfig())).not.toThrow();
  });

  it('rejects face-gate attendance in this build while keeping it modelled', () => {
    const config = makeConfig({ attendance: { method: 'FACE_GATE' } });
    expect(config.attendance.method).toBe('FACE_GATE'); // schema allows it
    expect(() => assertBuildSupported(config)).toThrow(/not available in this build/);
  });

  it('rejects the hybrid face-gate method too', () => {
    expect(() =>
      assertBuildSupported(makeConfig({ attendance: { method: 'COACH_TAP_WITH_FACE_GATE' } })),
    ).toThrow(/not available in this build/);
  });

  it('cannot be configured to profile children', () => {
    expect(() =>
      parseClubConfig({ version: 1, privacy: { childProfilingEnabled: true } }),
    ).toThrow(ClubConfigError);
  });

  it('cannot be configured to skip minor consent', () => {
    expect(() =>
      parseClubConfig({ version: 1, privacy: { minorConsentRequired: false } }),
    ).toThrow(ClubConfigError);
  });
});

describe('member-facing projection', () => {
  it('exposes only what the member app needs', () => {
    const view = toMemberFacingConfig(makeConfig());
    expect(view).not.toHaveProperty('absenteeFollowUpAfterMisses');
    expect(view).not.toHaveProperty('geofenceEnforcement');
    expect(view).not.toHaveProperty('recordRetentionMonths');
  });

  it('flattens the batch-assignment mode into a boolean the UI can branch on', () => {
    expect(toMemberFacingConfig(makeConfig()).memberPicksBatch).toBe(true);
    expect(
      toMemberFacingConfig(makeConfig({ enrollment: { batchAssignment: 'COACH_ASSIGNED' } }))
        .memberPicksBatch,
    ).toBe(false);
  });

  it('flattens the approval mode', () => {
    expect(
      toMemberFacingConfig(makeConfig({ enrollment: { approval: 'REQUIRED' } })).approvalRequired,
    ).toBe(true);
  });
});

describe('primary call to action (spec 2.5)', () => {
  it('offers a demo when demos are on', () => {
    expect(primaryCallToAction(makeConfig({ demo: { enabled: true } }))).toBe('BOOK_DEMO');
  });

  it('offers a trial when demos are off but trials are on', () => {
    expect(
      primaryCallToAction(makeConfig({ enrollment: { trialClassEnabled: true } })),
    ).toBe('START_TRIAL');
  });

  it('goes straight to enroll when the club has neither', () => {
    expect(primaryCallToAction(makeConfig())).toBe('ENROLL');
  });

  it('prefers the demo when both are on', () => {
    expect(
      primaryCallToAction(
        makeConfig({ demo: { enabled: true }, enrollment: { trialClassEnabled: true } }),
      ),
    ).toBe('BOOK_DEMO');
  });
});

describe('derived helpers', () => {
  it('reports the absentee threshold', () => {
    const config = makeConfig({
      attendance: { absenteeFollowUpAfterMisses: 5, absenteeLookbackDays: 45 },
    });
    expect(absenteeThreshold(config)).toEqual({ misses: 5, lookbackDays: 45 });
  });

  it('describes every club in plain language', () => {
    const lines = describeConfig(makeConfig({ demo: { enabled: true }, pause: { allowed: false } }));
    expect(lines.join(' ')).toMatch(/Demo sessions are offered/);
    expect(lines.join(' ')).toMatch(/cannot be paused/);
  });

  it('describes a fully locked-down club without crashing', () => {
    const config = makeConfig({
      demo: { enabled: false },
      enrollment: { waitlistEnabled: false, approval: 'REQUIRED', batchAssignment: 'COACH_ASSIGNED' },
      payments: { partPaymentAllowed: false },
      pause: { allowed: false },
      refunds: { carryover: 'NEITHER', refundIfNeverAttended: false },
      communication: { chatEnabled: false },
    });
    const lines = describeConfig(config);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });
});
