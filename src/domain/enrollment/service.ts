/**
 * Enrollment service — the database side of the state machine.
 *
 * The evaluator in `state-machine.ts` is pure and knows nothing about Prisma.
 * This module's job is to assemble its context faithfully and to apply the
 * actions it authorises, inside transactions that keep `Batch.activeCount`
 * honest under concurrency.
 */

import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { audit, type AuditContext } from '@/lib/audit';
import { parseClubConfig } from '../config/engine';
import { getConsentStatus } from '../consent/service';
import { ageInYearsOn } from '../player/age';
import { buildInstalmentPlan, assertPlanBalances, priceEnrollment } from '../money/pricing';
import {
  assertActionAllowed,
  resolveEnrollmentStep,
  type EnrollmentAction,
  type EnrollmentContext,
  type EnrollmentDecision,
} from './state-machine';

/** Minimal transactional client surface — lets helpers run inside a `$transaction`. */
type TxClient = Pick<typeof prisma, '$executeRaw'>;

/**
 * Return a claimed place to a batch.
 *
 * Floored at zero: a double release (a cancellation racing an expiry sweep,
 * say) must not drive the counter negative and silently oversell the batch
 * forever after.
 */
export async function releaseBatchPlace(tx: TxClient, batchId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "batches"
       SET "activeCount" = GREATEST("activeCount" - 1, 0)
     WHERE "id" = ${batchId}
  `;
}

export interface EnrollmentIntentInput {
  playerProfileId: string;
  clubId: string;
  batchId?: string | null;
  packageId?: string | null;
}

/**
 * Assemble everything the evaluator needs. One place, so a missing fact is a
 * bug here rather than a silently wrong branch three screens later.
 */
export async function buildEnrollmentContext(
  input: EnrollmentIntentInput,
): Promise<EnrollmentContext> {
  const [club, profile] = await Promise.all([
    prisma.club.findUnique({
      where: { id: input.clubId },
      select: { id: true, config: true, status: true },
    }),
    prisma.playerProfile.findUnique({
      where: { id: input.playerProfileId },
      select: { id: true, dateOfBirth: true, isMinor: true, status: true },
    }),
  ]);

  if (!club) throw ApiError.notFound('Club');
  if (!profile) throw ApiError.notFound('Player profile');
  if (profile.status === 'ARCHIVED') {
    throw ApiError.badRequest('This player profile is archived. Restore it before enrolling.');
  }

  const config = parseClubConfig(club.config);
  const consent = await getConsentStatus(profile.id);

  // Batch: either the one the member picked, or the one already recorded on an
  // in-flight membership, or the coach's recommendation.
  const existingMembership = await prisma.membership.findFirst({
    where: {
      playerProfileId: profile.id,
      batch: { clubId: club.id },
      status: { in: ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'ACTIVE', 'WAITLISTED', 'PAUSED'] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      instalments: { select: { id: true, paidAt: true } },
      package: { select: { id: true, batchId: true } },
    },
  });

  const batchId = input.batchId ?? existingMembership?.batchId ?? null;

  const batch = batchId
    ? await prisma.batch.findUnique({
        where: { id: batchId },
        select: {
          id: true,
          clubId: true,
          capacity: true,
          activeCount: true,
          minAge: true,
          maxAge: true,
          isActive: true,
          _count: { select: { waitlist: { where: { removedAt: null, promotedAt: null } } } },
        },
      })
    : null;

  if (batch && batch.clubId !== club.id) {
    throw ApiError.badRequest('That batch belongs to a different club.');
  }
  if (batch && !batch.isActive) {
    throw ApiError.badRequest('That batch is no longer taking members.');
  }

  const packageId = input.packageId ?? existingMembership?.packageId ?? null;
  const packageRow = packageId
    ? await prisma.package.findUnique({
        where: { id: packageId },
        select: { id: true, batchId: true, clubId: true, pricePaise: true, registrationFeePaise: true, isActive: true },
      })
    : null;

  if (packageRow && packageRow.clubId !== club.id) {
    throw ApiError.badRequest('That package belongs to a different club.');
  }

  const demo = await prisma.demoBooking.findFirst({
    where: { playerProfileId: profile.id, clubId: club.id },
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      feedbackRecordedAt: true,
      recommendedBatchId: true,
      recommendedPackageId: true,
      updatedAt: true,
    },
  });

  const waitlistEntry = batch
    ? await prisma.waitlistEntry.findUnique({
        where: { batchId_playerProfileId: { batchId: batch.id, playerProfileId: profile.id } },
        select: { id: true, removedAt: true, promotedAt: true },
      })
    : null;

  const outstandingInstalments =
    existingMembership?.instalments.filter((instalment) => instalment.paidAt === null).length ?? 0;

  return {
    config,
    player: {
      id: profile.id,
      isMinor: profile.isMinor,
      ageYears: ageInYearsOn(profile.dateOfBirth),
      hasActiveConsent: consent.satisfied,
    },
    batch: batch
      ? {
          id: batch.id,
          capacity: batch.capacity,
          activeCount: batch.activeCount,
          minAge: batch.minAge,
          maxAge: batch.maxAge,
          waitlistSize: batch._count.waitlist,
        }
      : null,
    package: packageRow
      ? { id: packageRow.id, batchId: packageRow.batchId, totalPaise: packageRow.pricePaise }
      : null,
    demo: demo
      ? {
          status: demo.status,
          feedbackRecorded: demo.feedbackRecordedAt !== null,
          // The member acknowledges the post-demo screen by proceeding; we
          // record that on the membership intent rather than the demo row.
          reviewAcknowledged: existingMembership !== null || input.batchId != null,
          recommendedBatchId: demo.recommendedBatchId,
          recommendedPackageId: demo.recommendedPackageId,
        }
      : null,
    payment: existingMembership
      ? {
          paidPaise: existingMembership.paidPaise,
          totalPaise: existingMembership.totalPaise,
          isPartPayment: existingMembership.isPartPayment,
          outstandingInstalments,
        }
      : null,
    onWaitlist: waitlistEntry !== null && waitlistEntry.removedAt === null && waitlistEntry.promotedAt === null,
    trialUsed: false,
    approval:
      existingMembership?.status === 'PENDING_APPROVAL'
        ? 'PENDING'
        : existingMembership?.approvedAt
          ? 'APPROVED'
          : null,
    waitlistDeclined: false,
  };
}

/** What screen should the member app show right now? */
export async function currentStep(input: EnrollmentIntentInput): Promise<EnrollmentDecision> {
  return resolveEnrollmentStep(await buildEnrollmentContext(input));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CreateEnrollmentInput extends EnrollmentIntentInput {
  batchId: string;
  packageId: string;
  accountId: string;
  selectedAddOnNames: string[];
  applyWalletCredit: boolean;
  usePartPayment: boolean;
  context?: AuditContext;
}

export interface CreateEnrollmentResult {
  membershipId: string;
  status: string;
  totalPaise: number;
  instalmentCount: number;
  decision: EnrollmentDecision;
}

/**
 * Create the membership and its payment schedule.
 *
 * Capacity is re-checked INSIDE the transaction with a conditional update, so
 * two parents tapping "enroll" on the last place cannot both get in — the
 * second one's update matches zero rows and is rejected.
 */
export async function createEnrollment(
  input: CreateEnrollmentInput,
): Promise<CreateEnrollmentResult> {
  const context = await buildEnrollmentContext(input);
  const action: EnrollmentAction = input.usePartPayment ? 'PAY_INSTALMENT' : 'PAY_FULL';
  assertActionAllowed(context, action);

  const [packageRow, account, priorRegistration] = await Promise.all([
    prisma.package.findUniqueOrThrow({
      where: { id: input.packageId },
      include: { addOns: true },
    }),
    prisma.account.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { id: true, walletBalancePaise: true },
    }),
    prisma.membership.findFirst({
      where: {
        playerProfile: { accountId: input.accountId },
        batch: { clubId: input.clubId },
        status: { notIn: ['CANCELLED'] },
      },
      select: { id: true },
    }),
  ]);

  const chargeRegistration =
    packageRow.registrationFeePaise > 0 &&
    (!context.config.payments.registrationFeeOncePerPlayer || priorRegistration === null);

  const breakdown = priceEnrollment({
    packagePricePaise: packageRow.pricePaise,
    packageLabel: packageRow.tierName,
    registrationFeePaise: packageRow.registrationFeePaise,
    chargeRegistration,
    addOns: packageRow.addOns.map((addOn) => ({
      name: addOn.name,
      pricePaise: addOn.pricePaise,
      mandatory: addOn.mandatory,
      oneTime: addOn.oneTime,
    })),
    selectedAddOnNames: input.selectedAddOnNames,
    availableCreditPaise: account.walletBalancePaise,
    applyCredit: input.applyWalletCredit,
  });

  const usePartPayment = input.usePartPayment && context.config.payments.partPaymentAllowed;
  const plan = buildInstalmentPlan({
    totalPaise: breakdown.totalPaise,
    config: usePartPayment
      ? context.config
      : { ...context.config, payments: { ...context.config.payments, partPaymentAllowed: false } },
    startDate: new Date(),
  });
  assertPlanBalances(plan);

  const initialStatus =
    context.config.enrollment.approval === 'REQUIRED' ? 'PENDING_APPROVAL' : 'PENDING_PAYMENT';

  const membership = await prisma.$transaction(async (tx) => {
    // Atomic capacity claim.
    //
    // A SELECT-then-check inside a transaction is NOT sufficient at READ
    // COMMITTED: two concurrent checkouts both read activeCount = 19 against a
    // capacity of 20 and both proceed. A single conditional UPDATE pushes the
    // comparison into the database, where row locking makes it serial — the
    // loser matches zero rows and is turned away.
    //
    // `activeCount` therefore counts CLAIMED places, not merely active ones.
    // It is incremented here and released by `releaseBatchPlace` whenever the
    // membership is cancelled or expires.
    const claimed = await tx.$executeRaw`
      UPDATE "batches"
         SET "activeCount" = "activeCount" + 1
       WHERE "id" = ${input.batchId}
         AND "activeCount" < "capacity"
    `;

    if (claimed === 0) {
      throw new ApiError('BATCH_AT_CAPACITY', 'That batch filled up while you were checking out.');
    }

    const created = await tx.membership.create({
      data: {
        playerProfileId: input.playerProfileId,
        packageId: input.packageId,
        batchId: input.batchId,
        status: initialStatus,
        totalPaise: breakdown.totalPaise,
        paidPaise: 0,
        carryoverPaise: breakdown.creditAppliedPaise,
        isPartPayment: usePartPayment,
        creditsTotal: packageRow.creditSessions,
        creditsRemaining: packageRow.creditSessions,
        addOnLines: {
          create: breakdown.lines
            .filter((line) => line.kind === 'ADDON')
            .map((line) => ({ name: line.label, pricePaise: line.amountPaise })),
        },
        instalments: {
          create: plan.entries.map((entry) => ({
            sequence: entry.sequence,
            amountPaise: entry.amountPaise,
            dueDate: entry.dueDate,
          })),
        },
      },
    });

    // Debit the wallet inside the same transaction as the credit line on the
    // membership, so the two can never disagree.
    if (breakdown.creditAppliedPaise > 0) {
      const updated = await tx.account.update({
        where: { id: input.accountId },
        data: { walletBalancePaise: { decrement: breakdown.creditAppliedPaise } },
        select: { walletBalancePaise: true },
      });
      if (updated.walletBalancePaise < 0) {
        throw ApiError.conflict('Wallet balance changed while checking out. Try again.');
      }
      await tx.walletEntry.create({
        data: {
          accountId: input.accountId,
          amountPaise: -breakdown.creditAppliedPaise,
          reason: 'applied_to_membership',
          membershipId: created.id,
          balanceAfterPaise: updated.walletBalancePaise,
        },
      });
    }

    return created;
  });

  await audit({
    action: 'membership.created',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: input.accountId,
    metadata: {
      playerProfileId: input.playerProfileId,
      batchId: input.batchId,
      packageId: input.packageId,
      totalPaise: breakdown.totalPaise,
      isPartPayment: usePartPayment,
      creditApplied: breakdown.creditAppliedPaise,
    },
    context: input.context,
  });

  return {
    membershipId: membership.id,
    status: membership.status,
    totalPaise: breakdown.totalPaise,
    instalmentCount: plan.entries.length,
    decision: await currentStep(input),
  };
}

/** Spec 2.7 / 3.7: join the queue when the batch is full. */
export async function joinWaitlist(params: {
  playerProfileId: string;
  clubId: string;
  batchId: string;
  packageId?: string;
  accountId: string;
  context?: AuditContext;
}): Promise<{ position: number }> {
  const context = await buildEnrollmentContext({
    playerProfileId: params.playerProfileId,
    clubId: params.clubId,
    batchId: params.batchId,
  });
  assertActionAllowed(context, 'JOIN_WAITLIST');

  const entry = await prisma.$transaction(async (tx) => {
    const last = await tx.waitlistEntry.findFirst({
      where: { batchId: params.batchId, removedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    return tx.waitlistEntry.upsert({
      where: {
        batchId_playerProfileId: {
          batchId: params.batchId,
          playerProfileId: params.playerProfileId,
        },
      },
      create: {
        batchId: params.batchId,
        playerProfileId: params.playerProfileId,
        packageId: params.packageId,
        position: (last?.position ?? 0) + 1,
      },
      update: { removedAt: null, promotedAt: null },
    });
  });

  await audit({
    action: 'waitlist.joined',
    entityType: 'WaitlistEntry',
    entityId: entry.id,
    actorAccountId: params.accountId,
    metadata: { batchId: params.batchId, playerProfileId: params.playerProfileId, position: entry.position },
    context: params.context,
  });

  return { position: entry.position };
}

/**
 * Spec 3.7: "promote to active when a slot frees". Called by the owner, and by
 * the cancellation path when a place opens up.
 */
export async function promoteFromWaitlist(params: {
  waitlistEntryId: string;
  actorAccountId: string;
  context?: AuditContext;
}): Promise<{ notifiedAccountId: string }> {
  const entry = await prisma.waitlistEntry.findUnique({
    where: { id: params.waitlistEntryId },
    include: {
      batch: { select: { id: true, capacity: true, activeCount: true, clubId: true, name: true } },
      playerProfile: { select: { id: true, accountId: true, fullName: true } },
    },
  });

  if (!entry) throw ApiError.notFound('Waitlist entry');
  if (entry.promotedAt) throw ApiError.conflict('That entry was already promoted.');
  if (entry.batch.activeCount >= entry.batch.capacity) {
    throw new ApiError('BATCH_AT_CAPACITY', 'There is still no free place in that batch.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { promotedAt: new Date() },
    });
    await tx.notification.create({
      data: {
        accountId: entry.playerProfile.accountId,
        playerProfileId: entry.playerProfile.id,
        type: 'WAITLIST_PROMOTED',
        title: 'A place has opened up',
        body: `${entry.playerProfile.fullName} can now join ${entry.batch.name}. Complete the enrollment to secure the place.`,
        data: { batchId: entry.batch.id, clubId: entry.batch.clubId },
      },
    });
  });

  await audit({
    action: 'waitlist.promoted',
    entityType: 'WaitlistEntry',
    entityId: entry.id,
    actorAccountId: params.actorAccountId,
    metadata: { batchId: entry.batch.id, playerProfileId: entry.playerProfile.id },
    context: params.context,
  });

  return { notifiedAccountId: entry.playerProfile.accountId };
}

/** Owner/coach decision when the club gates enrollment on approval. */
export async function decideApproval(params: {
  membershipId: string;
  approve: boolean;
  actorAccountId: string;
  coachId?: string;
  reason?: string;
  context?: AuditContext;
}): Promise<{ status: string }> {
  const membership = await prisma.membership.findUnique({
    where: { id: params.membershipId },
    select: { id: true, status: true, batchId: true, paidPaise: true, playerProfile: { select: { accountId: true, id: true, fullName: true } } },
  });

  if (!membership) throw ApiError.notFound('Membership');
  if (membership.status !== 'PENDING_APPROVAL') {
    throw ApiError.conflict(`This membership is ${membership.status.toLowerCase()}, not awaiting approval.`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (!params.approve) {
      // Hand the place back so the batch does not stay artificially full.
      await releaseBatchPlace(tx, membership.batchId);
      return tx.membership.update({
        where: { id: membership.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: params.reason ?? 'Not approved by the club.',
        },
      });
    }

    // Approval only activates once money has actually landed. The batch place
    // was already claimed at enrollment creation, so nothing is incremented
    // here — doing so would double-count the same member.
    const nextStatus = membership.paidPaise > 0 ? 'ACTIVE' : 'PENDING_PAYMENT';

    return tx.membership.update({
      where: { id: membership.id },
      data: {
        status: nextStatus,
        approvedAt: new Date(),
        approvedByCoachId: params.coachId,
        startDate: nextStatus === 'ACTIVE' ? new Date() : undefined,
      },
    });
  });

  await prisma.notification.create({
    data: {
      accountId: membership.playerProfile.accountId,
      playerProfileId: membership.playerProfile.id,
      type: 'ENROLLMENT_APPROVED',
      title: params.approve ? 'Enrollment approved' : 'Enrollment not approved',
      body: params.approve
        ? `${membership.playerProfile.fullName}'s enrollment has been approved by the club.`
        : `The club could not approve ${membership.playerProfile.fullName}'s enrollment. ${params.reason ?? ''}`.trim(),
      data: { membershipId: membership.id },
    },
  });

  await audit({
    action: params.approve ? 'membership.approved' : 'membership.rejected',
    entityType: 'Membership',
    entityId: membership.id,
    actorAccountId: params.actorAccountId,
    metadata: { reason: params.reason },
    context: params.context,
  });

  return { status: updated.status };
}
