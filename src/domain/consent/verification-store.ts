/**
 * Verification request lifecycle.
 *
 * The adapters in `verification.ts` know how to talk to a provider. This module
 * owns the question the adapters cannot answer: *is this requestId one we
 * actually issued, for this account, for this child, and is it still live?*
 *
 * Without that check the whole verification step is theatre — a client could
 * invent a requestId and the resulting consent record would attest to an
 * identity check that never happened.
 *
 * State machine:
 *
 *   start()  → PENDING (with PKCE verifier + state token held server-side)
 *   complete() on a PENDING, unexpired request → COMPLETED
 *   anything else → refused
 *
 * A COMPLETED request is single-use: `consumeCompleted()` is what the consent
 * grant calls, and it will not hand back the same verification twice.
 */

import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { audit, type AuditContext } from '@/lib/audit';
import { env } from '@/lib/env';
import {
  createPkcePair,
  createStateToken,
  getVerifier,
  newRequestId,
  VerificationError,
  type VerificationMethod,
  type VerificationResult,
  type VerificationStart,
} from './verification';

/** How long a parent has to finish a verification once it is started. */
const TTL_MINUTES = 15;
/** Manual offline checks happen at the ground, so they get far longer. */
const OFFLINE_TTL_MINUTES = 7 * 24 * 60;

export interface StartedVerification extends VerificationStart {
  method: VerificationMethod;
  isRedirectFlow: boolean;
}

/**
 * Begin a verification. Persists the request BEFORE handing anything to the
 * provider, so a redirect that comes back faster than our own write cannot
 * find a missing row.
 */
export async function startVerification(params: {
  accountId: string;
  playerProfileId: string;
  method?: VerificationMethod;
  context?: AuditContext;
}): Promise<StartedVerification> {
  const method =
    params.method ?? (env().CONSENT_VERIFIER === 'digilocker' ? 'DIGILOCKER' : 'MOCK');
  const verifier = getVerifier(method);

  const requestId = newRequestId();
  const stateToken = createStateToken();
  const ttl = method === 'MANUAL_OFFLINE' ? OFFLINE_TTL_MINUTES : TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  // PKCE only matters for the redirect flow; generating it unconditionally
  // would just put an unused secret in the database.
  const pkce = verifier.isRedirectFlow ? createPkcePair() : null;

  await prisma.consentVerificationRequest.create({
    data: {
      id: requestId,
      accountId: params.accountId,
      playerProfileId: params.playerProfileId,
      method,
      status: 'PENDING',
      codeVerifier: pkce?.verifier,
      stateToken,
      expiresAt,
      ipAddress: params.context?.ipAddress ?? null,
      userAgent: params.context?.userAgent ?? null,
    },
  });

  let started: VerificationStart;
  try {
    started = await verifier.start({
      requestId,
      accountId: params.accountId,
      playerProfileId: params.playerProfileId,
      codeChallenge: pkce?.challenge,
      stateToken,
      expiresAt,
    });
  } catch (error) {
    // A provider that will not even start leaves a dead row; mark it so the
    // expiry sweep does not have to guess why.
    await prisma.consentVerificationRequest.update({
      where: { id: requestId },
      data: {
        status: 'FAILED',
        failureReason: error instanceof Error ? error.message : 'Could not start verification.',
      },
    });
    throw error;
  }

  await audit({
    action: 'consent.verification_started',
    entityType: 'ConsentVerificationRequest',
    entityId: requestId,
    actorAccountId: params.accountId,
    metadata: { method, playerProfileId: params.playerProfileId },
    context: params.context,
  });

  return { ...started, method, isRedirectFlow: verifier.isRedirectFlow };
}

/**
 * Finish a verification.
 *
 * Every guard here exists because of a specific way this could be abused:
 * a forged requestId, someone else's request, a request for a different child,
 * a replayed completion, or an abandoned one resurrected weeks later.
 */
export async function completeVerification(params: {
  requestId: string;
  accountId: string;
  playerProfileId?: string;
  payload: Record<string, unknown>;
  context?: AuditContext;
}): Promise<VerificationResult> {
  const request = await prisma.consentVerificationRequest.findUnique({
    where: { id: params.requestId },
    include: { account: { select: { name: true } } },
  });

  if (!request) {
    throw ApiError.consentRequired('That verification was not started by this server.');
  }
  if (request.accountId !== params.accountId) {
    // Deliberately the same message as "not found": telling a caller that a
    // request exists but belongs to someone else is itself a disclosure.
    throw ApiError.consentRequired('That verification was not started by this server.');
  }
  if (params.playerProfileId && request.playerProfileId !== params.playerProfileId) {
    throw ApiError.consentRequired('That verification was started for a different player.');
  }
  if (request.status === 'COMPLETED') {
    throw ApiError.conflict('That verification has already been used.');
  }
  if (request.status !== 'PENDING') {
    throw ApiError.consentRequired(
      `That verification is ${request.status.toLowerCase()}. Start a new one.`,
    );
  }
  if (request.expiresAt.getTime() < Date.now()) {
    await prisma.consentVerificationRequest.update({
      where: { id: request.id },
      data: { status: 'EXPIRED' },
    });
    throw ApiError.consentRequired('That verification expired. Start a new one.');
  }

  const verifier = getVerifier(request.method);

  let result: VerificationResult;
  try {
    result = await verifier.complete({
      requestId: request.id,
      accountId: request.accountId,
      payload: params.payload,
      codeVerifier: request.codeVerifier ?? undefined,
      accountName: request.account.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed.';
    const retryable = error instanceof VerificationError && error.retryable;

    await prisma.consentVerificationRequest.update({
      where: { id: request.id },
      // A retryable provider blip leaves the request PENDING so the parent can
      // try again without starting over; a real rejection is terminal.
      data: retryable
        ? { failureReason: message }
        : { status: 'FAILED', failureReason: message },
    });

    await audit({
      action: 'consent.verification_failed',
      entityType: 'ConsentVerificationRequest',
      entityId: request.id,
      actorAccountId: request.accountId,
      metadata: { method: request.method, retryable, reason: message },
      context: params.context,
    });

    throw error;
  }

  await prisma.consentVerificationRequest.update({
    where: { id: request.id },
    data: {
      status: 'COMPLETED',
      completedAt: result.verifiedAt,
      resultReference: result.reference,
      // The PKCE secret has done its job; keeping it is pure liability.
      codeVerifier: null,
    },
  });

  await audit({
    action: 'consent.verification_succeeded',
    entityType: 'ConsentVerificationRequest',
    entityId: request.id,
    actorAccountId: request.accountId,
    metadata: {
      method: request.method,
      reference: result.reference,
      note: result.note,
      playerProfileId: request.playerProfileId,
    },
    context: params.context,
  });

  return result;
}

/**
 * Look up a request by the state token a provider echoed back on redirect.
 * The token is unguessable, which is what makes the callback endpoint safe to
 * expose unauthenticated — the provider cannot present a session cookie.
 */
export async function findByStateToken(stateToken: string) {
  return prisma.consentVerificationRequest.findUnique({
    where: { stateToken },
    select: {
      id: true,
      accountId: true,
      playerProfileId: true,
      method: true,
      status: true,
      expiresAt: true,
    },
  });
}

/**
 * Redeem an already-COMPLETED verification when the consent grant is submitted.
 *
 * Single-use: a completed request is consumed here so one identity check cannot
 * back two different consent records.
 */
export async function consumeCompleted(params: {
  requestId: string;
  accountId: string;
  playerProfileId: string;
}): Promise<VerificationResult> {
  const request = await prisma.consentVerificationRequest.findUnique({
    where: { id: params.requestId },
  });

  if (!request || request.accountId !== params.accountId) {
    throw ApiError.consentRequired('That verification was not started by this server.');
  }
  if (request.playerProfileId !== params.playerProfileId) {
    throw ApiError.consentRequired('That verification was started for a different player.');
  }
  if (request.status !== 'COMPLETED' || !request.resultReference || !request.completedAt) {
    throw ApiError.consentRequired('Complete the identity verification before granting consent.');
  }

  // Consent must follow verification closely. A month-old check is not evidence
  // that the person consenting today is the one who verified.
  const ageMinutes = (Date.now() - request.completedAt.getTime()) / 60_000;
  if (ageMinutes > 60) {
    throw ApiError.consentRequired(
      'That identity check is too old to use. Please verify again.',
    );
  }

  return {
    verified: true,
    method: request.method as VerificationMethod,
    reference: request.resultReference,
    verifiedAt: request.completedAt,
  };
}

/** Housekeeping for a nightly job. */
export async function expireStaleRequests(): Promise<number> {
  const result = await prisma.consentVerificationRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED', codeVerifier: null },
  });
  return result.count;
}
