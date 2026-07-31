/**
 * Consent lifecycle: grant, check, withdraw.
 *
 * Spec 2.3. Rules encoded here:
 *   - A consent record is IMMUTABLE once written, except for withdrawal.
 *     Changing scope creates a new record, so the history stays intact.
 *   - Withdrawal is honoured downstream: withdrawing a required scope suspends
 *     the memberships that depend on it.
 *   - Every consent event is audit-logged.
 */

import { prisma } from '@/lib/db';
import { audit, type AuditContext } from '@/lib/audit';
import { ApiError } from '@/lib/api/errors';
import {
  CONSENT_NOTICE_VERSION,
  isConsentScope,
  renderNotice,
  validateScopeSelection,
  type ConsentScope,
} from './scopes';
import type { VerificationResult } from './verification';

export interface ConsentStatus {
  /** An active record covering every required scope exists. */
  satisfied: boolean;
  activeScopes: ConsentScope[];
  missingRequiredScopes: ConsentScope[];
  recordId: string | null;
  grantedAt: Date | null;
  verificationMethod: string | null;
}

/**
 * The single source of truth for "may we process this child's data?".
 * Called by the enrollment state machine's context builder, and by anything
 * that reads a minor's record.
 */
export async function getConsentStatus(playerProfileId: string): Promise<ConsentStatus> {
  const profile = await prisma.playerProfile.findUnique({
    where: { id: playerProfileId },
    select: { id: true, isMinor: true },
  });

  if (!profile) throw ApiError.notFound('Player profile');

  // An adult player consents for themselves through the terms of use; the
  // guardian-consent machinery does not apply.
  if (!profile.isMinor) {
    return {
      satisfied: true,
      activeScopes: [],
      missingRequiredScopes: [],
      recordId: null,
      grantedAt: null,
      verificationMethod: null,
    };
  }

  const active = await prisma.consentRecord.findFirst({
    where: { playerProfileId, state: 'ACTIVE' },
    orderBy: { grantedAt: 'desc' },
  });

  if (!active) {
    const { missing } = validateScopeSelection([]);
    return {
      satisfied: false,
      activeScopes: [],
      missingRequiredScopes: missing,
      recordId: null,
      grantedAt: null,
      verificationMethod: null,
    };
  }

  const activeScopes = active.scopes.filter(isConsentScope);
  const { ok, missing } = validateScopeSelection(activeScopes);

  return {
    satisfied: ok && active.verifiedAt !== null,
    activeScopes,
    missingRequiredScopes: missing,
    recordId: active.id,
    grantedAt: active.grantedAt,
    verificationMethod: active.verificationMethod,
  };
}

export async function hasActiveConsent(playerProfileId: string): Promise<boolean> {
  return (await getConsentStatus(playerProfileId)).satisfied;
}

/**
 * Record a consent grant.
 *
 * Requires a completed verification result — an unverified "I agree" tap does
 * not meet the verifiable-parent-identity requirement.
 */
export async function grantConsent(params: {
  playerProfileId: string;
  consentingAccountId: string;
  scopes: ConsentScope[];
  verification: VerificationResult;
  context?: AuditContext;
}): Promise<{ recordId: string }> {
  const { playerProfileId, consentingAccountId, scopes, verification, context } = params;

  if (!verification.verified) {
    throw ApiError.consentRequired('Parent identity was not verified.');
  }

  const { ok, missing } = validateScopeSelection(scopes);
  if (!ok) {
    throw ApiError.policyViolation(
      'Consent is missing purposes the service cannot run without.',
      { missingRequiredScopes: missing },
    );
  }

  const profile = await prisma.playerProfile.findUnique({
    where: { id: playerProfileId },
    select: { id: true, accountId: true, isMinor: true },
  });
  if (!profile) throw ApiError.notFound('Player profile');

  if (profile.accountId !== consentingAccountId) {
    throw ApiError.forbidden('Only the account holding this player profile can consent for them.');
  }

  if (!profile.isMinor) {
    throw ApiError.badRequest('This player is an adult and consents for themselves.');
  }

  const noticeText = renderNotice(scopes);

  const record = await prisma.$transaction(async (tx) => {
    // Supersede any earlier grant so exactly one record is ACTIVE at a time.
    await tx.consentRecord.updateMany({
      where: { playerProfileId, state: 'ACTIVE' },
      data: { state: 'WITHDRAWN', withdrawnAt: new Date(), withdrawalReason: 'Superseded by a new consent grant.' },
    });

    const created = await tx.consentRecord.create({
      data: {
        playerProfileId,
        consentingAccountId,
        scopes,
        noticeVersion: CONSENT_NOTICE_VERSION,
        noticeText,
        verificationMethod:
          verification.method === 'DIGILOCKER'
            ? 'DIGILOCKER'
            : verification.method === 'MANUAL_OFFLINE'
              ? 'MANUAL_OFFLINE'
              : 'MOCK',
        verificationReference: verification.reference,
        verifiedAt: verification.verifiedAt,
        state: 'ACTIVE',
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      },
    });

    await tx.account.update({
      where: { id: consentingAccountId },
      data: { hasConsentOnFile: true },
    });

    return created;
  });

  await audit({
    action: 'consent.granted',
    entityType: 'ConsentRecord',
    entityId: record.id,
    actorAccountId: consentingAccountId,
    metadata: {
      playerProfileId,
      scopes,
      noticeVersion: CONSENT_NOTICE_VERSION,
      verificationMethod: verification.method,
      verificationReference: verification.reference,
    },
    context,
  });

  return { recordId: record.id };
}

/**
 * Withdraw consent, in whole or for specific purposes.
 *
 * Spec 2.3: "withdrawal must be honoured downstream (stop processing, support
 * erasure)". Withdrawing a required purpose therefore cancels the memberships
 * that depend on it rather than leaving a membership running on data we are no
 * longer permitted to process.
 */
export async function withdrawConsent(params: {
  playerProfileId: string;
  accountId: string;
  /** Omit to withdraw entirely. */
  scopes?: ConsentScope[];
  reason?: string;
  context?: AuditContext;
}): Promise<{ withdrawnEntirely: boolean; affectedMembershipIds: string[] }> {
  const { playerProfileId, accountId, scopes, reason, context } = params;

  const current = await prisma.consentRecord.findFirst({
    where: { playerProfileId, state: 'ACTIVE' },
    orderBy: { grantedAt: 'desc' },
  });

  if (!current) throw ApiError.notFound('Active consent record');
  if (current.consentingAccountId !== accountId) {
    throw ApiError.forbidden('Only the account that gave consent can withdraw it.');
  }

  const currentScopes = current.scopes.filter(isConsentScope);
  const remaining = scopes
    ? currentScopes.filter((scope) => !scopes.includes(scope))
    : [];

  const stillSatisfiesRequired = validateScopeSelection(remaining).ok;
  const withdrawnEntirely = remaining.length === 0 || !stillSatisfiesRequired;

  const affectedMembershipIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.consentRecord.update({
      where: { id: current.id },
      data: {
        state: 'WITHDRAWN',
        withdrawnAt: new Date(),
        withdrawalReason: reason ?? 'Withdrawn by the account holder.',
      },
    });

    // A partial withdrawal that still covers every required purpose leaves the
    // membership running under a fresh, narrower record.
    if (!withdrawnEntirely) {
      await tx.consentRecord.create({
        data: {
          playerProfileId,
          consentingAccountId: accountId,
          scopes: remaining,
          noticeVersion: CONSENT_NOTICE_VERSION,
          noticeText: renderNotice(remaining),
          verificationMethod: current.verificationMethod,
          verificationReference: current.verificationReference,
          verifiedAt: current.verifiedAt,
          state: 'ACTIVE',
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        },
      });
      return;
    }

    // Full withdrawal: stop processing. Memberships cannot continue.
    const memberships = await tx.membership.findMany({
      where: {
        playerProfileId,
        status: { in: ['ACTIVE', 'PAUSED', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'WAITLISTED'] },
      },
      select: { id: true, batchId: true, status: true },
    });

    for (const membership of memberships) {
      affectedMembershipIds.push(membership.id);
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationEffectiveAt: new Date(),
          cancellationReason: 'Guardian consent withdrawn.',
        },
      });
      // `activeCount` counts CLAIMED places, so every status that holds one
      // must release it. A waitlisted member never claimed a place.
      if (membership.status !== 'WAITLISTED') {
        await tx.$executeRaw`
          UPDATE "batches"
             SET "activeCount" = GREATEST("activeCount" - 1, 0)
           WHERE "id" = ${membership.batchId}
        `;
      }
    }

    await tx.waitlistEntry.updateMany({
      where: { playerProfileId, removedAt: null },
      data: { removedAt: new Date() },
    });

    const otherActive = await tx.consentRecord.count({
      where: { consentingAccountId: accountId, state: 'ACTIVE' },
    });
    if (otherActive === 0) {
      await tx.account.update({ where: { id: accountId }, data: { hasConsentOnFile: false } });
    }
  });

  await audit({
    action: 'consent.withdrawn',
    entityType: 'ConsentRecord',
    entityId: current.id,
    actorAccountId: accountId,
    metadata: {
      playerProfileId,
      withdrawnScopes: scopes ?? currentScopes,
      remainingScopes: withdrawnEntirely ? [] : remaining,
      withdrawnEntirely,
      affectedMembershipIds,
      reason,
    },
    context,
  });

  return { withdrawnEntirely, affectedMembershipIds };
}

/**
 * Guard for any code path that processes a minor's data. Cheap enough to call
 * liberally — it is one indexed lookup, and the cost of getting this wrong is
 * a regulatory one.
 */
export async function assertMayProcess(playerProfileId: string, scope: ConsentScope): Promise<void> {
  const status = await getConsentStatus(playerProfileId);

  if (status.recordId === null && status.satisfied) return; // adult player

  if (!status.satisfied) {
    throw ApiError.consentRequired(
      'Verified guardian consent is required before this player’s data can be processed.',
    );
  }

  if (!status.activeScopes.includes(scope)) {
    throw new ApiError(
      'CONSENT_WITHDRAWN',
      `The guardian has not consented to "${scope}" for this player.`,
    );
  }
}
