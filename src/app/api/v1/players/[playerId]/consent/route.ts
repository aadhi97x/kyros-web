import { z } from 'zod';
import { ok, created } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import {
  getConsentStatus,
  grantConsent,
  withdrawConsent,
} from '@/domain/consent/service';
import {
  CONSENT_NOTICE_VERSION,
  CONSENT_SCOPE_DEFINITIONS,
  consentScopes,
  renderNotice,
} from '@/domain/consent/scopes';
import { defaultVerifier, getVerifier } from '@/domain/consent/verification';
import { auditContextFrom } from '@/lib/audit';

type Params = { playerId: string };

const scopeEnum = z.enum(consentScopes);

/**
 * GET /api/v1/players/:playerId/consent
 *
 * Everything the consent screen needs: the current state, and the full
 * unbundled list of purposes with plain-language explanations (spec 2.3).
 */
export const GET = authedRoute<Params>(async ({ params, actor }) => {
  await assertOwnsPlayerProfile(actor, params.playerId);
  const status = await getConsentStatus(params.playerId);

  return ok({
    status,
    noticeVersion: CONSENT_NOTICE_VERSION,
    // The parent ticks these individually. Required ones cannot be unticked;
    // optional ones must be genuinely declinable.
    purposes: CONSENT_SCOPE_DEFINITIONS,
    verificationMethod: defaultVerifier().method,
  });
});

const grantSchema = z.object({
  scopes: z.array(scopeEnum).min(1),
  /** From the verification handshake — a bare "I agree" is not enough. */
  verification: z.object({
    method: z.enum(['DIGILOCKER', 'MOCK', 'MANUAL_OFFLINE']),
    requestId: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
  }),
});

/**
 * POST /api/v1/players/:playerId/consent
 *
 * Completes verification and records the grant in one step, so a verified
 * identity can never be separated from the consent it was collected for.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, grantSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, params.playerId);

  const verifier = getVerifier(body.verification.method);
  const result = await verifier.complete({
    requestId: body.verification.requestId,
    accountId: actor.accountId,
    payload: body.verification.payload,
  });

  const { recordId } = await grantConsent({
    playerProfileId: params.playerId,
    consentingAccountId: actor.accountId,
    scopes: body.scopes,
    verification: result,
    context,
  });

  return created({
    recordId,
    scopes: body.scopes,
    noticeVersion: CONSENT_NOTICE_VERSION,
    noticeText: renderNotice(body.scopes),
    verifiedAt: result.verifiedAt,
  });
});

const withdrawSchema = z.object({
  /** Omit to withdraw everything. */
  scopes: z.array(scopeEnum).optional(),
  reason: z.string().max(500).optional(),
});

/**
 * DELETE /api/v1/players/:playerId/consent
 *
 * Spec 2.3: withdrawable at any time, honoured downstream. Withdrawing a
 * required purpose ends the memberships that depend on it — the response says
 * so explicitly rather than leaving the parent to discover it.
 */
export const DELETE = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, withdrawSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, params.playerId);

  const result = await withdrawConsent({
    playerProfileId: params.playerId,
    accountId: actor.accountId,
    scopes: body.scopes,
    reason: body.reason,
    context,
  });

  return ok({
    withdrawnEntirely: result.withdrawnEntirely,
    cancelledMembershipIds: result.affectedMembershipIds,
    message: result.withdrawnEntirely
      ? 'Consent withdrawn. We have stopped processing this player’s data and ended their memberships.'
      : 'Those purposes have been withdrawn. The membership continues under the remaining consent.',
  });
});
