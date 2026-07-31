/**
 * The club configuration schema.
 *
 * Spec 3.2: "Store a `config` object per club. The member app reads it at
 * runtime and branches. Keep this engine isolated and heavily tested. It is the
 * single biggest source of behavioural bugs."
 *
 * Rules for this file:
 *   1. Nothing here may import from `@/lib/db`, Next.js, or any I/O. It is a
 *      pure, self-contained module so it can be exhaustively unit-tested and
 *      shipped to the mobile client unchanged.
 *   2. Every toggle gets an explicit default. A club that never touched the
 *      wizard must still produce a valid, sane config.
 *   3. The config is VERSIONED. Adding a toggle means bumping the version and
 *      adding a migration step in `migrate.ts` — never silently reinterpreting
 *      an old shape.
 */

import { z } from 'zod';

export const CLUB_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Option unions
// ---------------------------------------------------------------------------

export const batchAssignmentModes = ['COACH_ASSIGNED', 'MEMBER_SELF_SELECT'] as const;
export const enrollmentApprovalModes = ['REQUIRED', 'AUTO_CONFIRM_ON_PAYMENT'] as const;
export const carryoverPolicies = ['CARRYOVER_CREDIT', 'ADJUST_NEXT_MONTH', 'NEITHER'] as const;
export const attendanceMethods = [
  'COACH_TAP',
  'FACE_GATE',
  'COACH_TAP_WITH_FACE_GATE',
] as const;
export const capacityBehaviours = ['WAITLIST', 'BLOCK'] as const;

export type BatchAssignmentMode = (typeof batchAssignmentModes)[number];
export type EnrollmentApprovalMode = (typeof enrollmentApprovalModes)[number];
export type CarryoverPolicy = (typeof carryoverPolicies)[number];
export type AttendanceMethodOption = (typeof attendanceMethods)[number];

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const demoConfigSchema = z.object({
  /** Spec 2.5: when off, the package detail CTA goes straight to "Enroll now". */
  enabled: z.boolean().default(false),
  /** Charge for the demo, in paise. 0 = free demo. */
  feePaise: z.number().int().min(0).default(0),
  /** How far ahead a member may book a demo slot. */
  bookingWindowDays: z.number().int().min(1).max(90).default(14),
  /** Block booking a slot starting sooner than this. */
  minNoticeHours: z.number().int().min(0).max(168).default(12),
  /**
   * When true a member cannot enroll until a coach has recorded demo feedback.
   * Only meaningful while `enabled` is true — cross-checked in `refine`.
   */
  requiredBeforeEnrollment: z.boolean().default(false),
});

const enrollmentConfigSchema = z.object({
  /** Spec 2.7 branch: who picks the batch. */
  batchAssignment: z.enum(batchAssignmentModes).default('MEMBER_SELF_SELECT'),
  /** Spec 2.7 branch: gate on human approval, or confirm the moment money lands. */
  approval: z.enum(enrollmentApprovalModes).default('AUTO_CONFIRM_ON_PAYMENT'),
  /** Spec 2.7 branch: a free/paid trial class distinct from a demo. */
  trialClassEnabled: z.boolean().default(false),
  trialClassCount: z.number().int().min(1).max(10).default(1),
  /** Spec 2.7 / 3.3: what happens when the chosen batch is full. */
  waitlistEnabled: z.boolean().default(true),
  /** Cap the queue so it does not become a fiction. 0 = unlimited. */
  waitlistMaxSize: z.number().int().min(0).max(500).default(50),
  /** Reject enrollment if the player's age falls outside the batch age band. */
  enforceAgeBand: z.boolean().default(true),
  /** Grace in years applied either side of the band when enforcing. */
  ageBandToleranceYears: z.number().int().min(0).max(3).default(0),
});

const paymentConfigSchema = z.object({
  /** Spec 3.2 "Part payment: allowed / not allowed". */
  partPaymentAllowed: z.boolean().default(false),
  /** Number of instalments when part payment is on. */
  partPaymentSplits: z.number().int().min(2).max(12).default(2),
  /** Days between instalments. */
  partPaymentGapDays: z.number().int().min(1).max(180).default(30),
  /** Fraction of the total that must be paid up front, in basis points. */
  partPaymentUpfrontBps: z.number().int().min(0).max(10000).default(5000),
  /** Days after the due date before an instalment is flagged overdue. */
  instalmentGraceDays: z.number().int().min(0).max(30).default(3),
  /** Reminder cadence before an instalment falls due. */
  instalmentReminderDaysBefore: z.array(z.number().int().min(0).max(30)).default([7, 3, 1]),
  /** Registration fee is charged once per player, not per membership. */
  registrationFeeOncePerPlayer: z.boolean().default(true),
});

const pausePolicySchema = z.object({
  /** Spec 3.2 "Pause policy: allowed + rules / not allowed". */
  allowed: z.boolean().default(true),
  /** Cumulative pause days permitted per membership year. */
  maxDaysPerYear: z.number().int().min(0).max(365).default(60),
  /** Shortest pause the club will process. */
  minDays: z.number().int().min(1).max(90).default(7),
  /** Notice the member must give before the pause start date. */
  noticeDays: z.number().int().min(0).max(60).default(3),
  /** Reasons the club accepts. Empty = any reason. */
  acceptedReasons: z
    .array(z.enum(['INJURY', 'ILLNESS', 'TRAVEL', 'OTHER']))
    .default(['INJURY', 'ILLNESS']),
  /** Require a doctor's note for injury/illness pauses beyond this length. */
  proofRequiredAboveDays: z.number().int().min(0).max(365).default(30),
});

const refundPolicySchema = z.object({
  /** Spec 3.2 "Refund if never attended: yes / no". */
  refundIfNeverAttended: z.boolean().default(true),
  /** Window in which the never-attended refund can be claimed. */
  neverAttendedWindowDays: z.number().int().min(0).max(90).default(14),
  /**
   * Spec 3.2 "Carryover: carryover credit / adjust to next month / neither".
   * Drives what a pause or a cancellation mid-cycle produces.
   */
  carryover: z.enum(carryoverPolicies).default('CARRYOVER_CREDIT'),
  /** Spec 3.2 "Cancellation notice: number of days". */
  cancellationNoticeDays: z.number().int().min(0).max(180).default(30),
  /** Percentage of the unused balance returned on cancellation, in bps. */
  cancellationRefundBps: z.number().int().min(0).max(10000).default(0),
  /** Registration fees and mandatory kit are usually non-refundable. */
  registrationFeeRefundable: z.boolean().default(false),
  addOnsRefundable: z.boolean().default(false),
});

const attendanceConfigSchema = z.object({
  /**
   * Spec 3.2 marks COACH_TAP as the only method in this build; spec 4.3 asks
   * that clubs be able to choose, with manual as the backup when a face-
   * recognition gate exists. The enum carries all three so the choice is
   * already modelled; `assertBuildSupported` gates what may actually be saved.
   */
  method: z.enum(attendanceMethods).default('COACH_TAP'),
  /** Minutes after session start beyond which a present mark becomes LATE. */
  lateThresholdMinutes: z.number().int().min(0).max(120).default(15),
  /** Spec 3.7 absentee follow-up trigger. */
  absenteeFollowUpAfterMisses: z.number().int().min(1).max(20).default(3),
  /** Window the miss count is measured over. */
  absenteeLookbackDays: z.number().int().min(7).max(180).default(30),
  /** Spec 4.2: reject coach check-in outside the fence, or flag for review. */
  geofenceEnforcement: z.enum(['REJECT', 'FLAG_FOR_REVIEW', 'OFF']).default('FLAG_FOR_REVIEW'),
  /** How long the coach may edit a saved attendance record. */
  editWindowHours: z.number().int().min(0).max(168).default(24),
});

const communicationConfigSchema = z.object({
  /** Spec 3.2 "Batch chat: on / off". */
  batchChatEnabled: z.boolean().default(true),
  /** Spec 2.12: one-to-one chat with club/coach, where the club enables it. */
  directChatEnabled: z.boolean().default(false),
  /** Spec 2.12: "Chat can be switched off entirely per club." */
  chatEnabled: z.boolean().default(true),
  /** Members can only post during these hours; coaches are exempt. */
  memberPostingHours: z
    .object({
      startMinute: z.number().int().min(0).max(1439).default(0),
      endMinute: z.number().int().min(0).max(1439).default(1439),
    })
    .default({ startMinute: 0, endMinute: 1439 }),
  notificationDefaults: z
    .object({
      sessionReminders: z.boolean().default(true),
      sessionReminderHoursBefore: z.number().int().min(1).max(72).default(12),
      paymentReminders: z.boolean().default(true),
      absenteeFollowUps: z.boolean().default(true),
      reportPublished: z.boolean().default(true),
    })
    .default({
      sessionReminders: true,
      sessionReminderHoursBefore: 12,
      paymentReminders: true,
      absenteeFollowUps: true,
      reportPublished: true,
    }),
});

const privacyConfigSchema = z.object({
  /**
   * Spec 2.3. Not a club-facing toggle in the usual sense — clubs cannot turn
   * consent off. They can only choose a stricter posture.
   */
  minorConsentRequired: z.literal(true).default(true),
  /** Spec 2.3: verifiable parent identity, pluggable. */
  parentVerificationMethod: z.enum(['DIGILOCKER', 'MANUAL_OFFLINE', 'MOCK']).default('DIGILOCKER'),
  /** Spec 2.3: no profiling or behavioural tracking of children. Immutable. */
  childProfilingEnabled: z.literal(false).default(false),
  /** Show a player's photo to other members in the batch roster / chat. */
  showPlayerPhotosToOtherMembers: z.boolean().default(false),
  /** Retention for attendance and assessment records after a membership ends. */
  recordRetentionMonths: z.number().int().min(6).max(120).default(36),
});

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const clubConfigSchema = z
  .object({
    version: z.literal(CLUB_CONFIG_VERSION).default(CLUB_CONFIG_VERSION),
    demo: demoConfigSchema.default({}),
    enrollment: enrollmentConfigSchema.default({}),
    payments: paymentConfigSchema.default({}),
    pause: pausePolicySchema.default({}),
    refunds: refundPolicySchema.default({}),
    attendance: attendanceConfigSchema.default({}),
    communication: communicationConfigSchema.default({}),
    privacy: privacyConfigSchema.default({}),
  })
  .superRefine((config, ctx) => {
    // A demo cannot be required before enrollment if demos are switched off —
    // that combination would make the club impossible to join.
    if (!config.demo.enabled && config.demo.requiredBeforeEnrollment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['demo', 'requiredBeforeEnrollment'],
        message:
          'demo.requiredBeforeEnrollment cannot be true while demo.enabled is false — members would have no way to join.',
      });
    }

    // Waitlist size only means something when the waitlist is on.
    if (!config.enrollment.waitlistEnabled && config.enrollment.waitlistMaxSize > 0) {
      // Not an error; normalised in `normaliseConfig`. Flag nothing here.
    }

    // Part payment split settings are meaningless — and misleading in the UI —
    // when part payment is off, but they are not invalid. The upfront share,
    // however, must leave something for the remaining instalments.
    if (config.payments.partPaymentAllowed && config.payments.partPaymentUpfrontBps >= 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payments', 'partPaymentUpfrontBps'],
        message:
          'partPaymentUpfrontBps must be below 10000 (100%) — otherwise there is nothing left to instal.',
      });
    }

    if (config.pause.allowed && config.pause.minDays > config.pause.maxDaysPerYear) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pause', 'minDays'],
        message: 'pause.minDays cannot exceed pause.maxDaysPerYear — no pause could ever qualify.',
      });
    }

    if (config.pause.allowed && config.pause.acceptedReasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pause', 'acceptedReasons'],
        message:
          'pause.acceptedReasons cannot be empty while pauses are allowed. Set pause.allowed to false instead.',
      });
    }

    // Direct chat and batch chat are both dead if chat is off entirely.
    if (
      !config.communication.chatEnabled &&
      (config.communication.batchChatEnabled || config.communication.directChatEnabled)
    ) {
      // Normalised rather than rejected — the owner flipping the master switch
      // should not have to hunt down the child toggles.
    }

    const { startMinute, endMinute } = config.communication.memberPostingHours;
    if (startMinute > endMinute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['communication', 'memberPostingHours'],
        message: 'memberPostingHours.startMinute must not be after endMinute.',
      });
    }
  });

export type ClubConfig = z.infer<typeof clubConfigSchema>;
export type ClubConfigInput = z.input<typeof clubConfigSchema>;

// Individual section types, handy for the wizard step components.
export type DemoConfig = ClubConfig['demo'];
export type EnrollmentConfig = ClubConfig['enrollment'];
export type PaymentConfig = ClubConfig['payments'];
export type PausePolicy = ClubConfig['pause'];
export type RefundPolicy = ClubConfig['refunds'];
export type AttendanceConfig = ClubConfig['attendance'];
export type CommunicationConfig = ClubConfig['communication'];
export type PrivacyConfig = ClubConfig['privacy'];
