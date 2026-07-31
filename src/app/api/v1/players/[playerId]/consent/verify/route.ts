import { z } from 'zod';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { startVerification, completeVerification } from '@/domain/consent/verification-store';
import { auditContextFrom } from '@/lib/audit';

type Params = { playerId: string };

const startSchema = z.object({
  method: z.enum(['DIGILOCKER', 'MOCK', 'MANUAL_OFFLINE']).optional(),
});

/**
 * POST /api/v1/players/:playerId/consent/verify
 *
 * Starts the parent-identity handshake (spec 2.3). Returns either a redirect
 * URL (DigiLocker) or an instruction (mock, offline), plus the requestId that
 * must be quoted when the grant is submitted.
 *
 * The requestId is now backed by a persisted row, so it can be proved to
 * correspond to a verification this server actually started, for this account
 * and this child.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, startSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, params.playerId);

  const started = await startVerification({
    accountId: actor.accountId,
    playerProfileId: params.playerId,
    method: body.method,
    context,
  });

  return ok({
    method: started.method,
    requestId: started.requestId,
    // A redirect flow finishes at the DigiLocker callback; a non-redirect flow
    // finishes at PUT below. The client branches on this.
    isRedirectFlow: started.isRedirectFlow,
    redirectUrl: started.redirectUrl ?? null,
    instruction: started.instruction ?? null,
    expiresAt: started.expiresAt,
  });
});

const completeSchema = z.object({
  requestId: z.string().min(1),
  /** Verifier-specific: `{ confirm: true }` for mock, attestation for offline. */
  payload: z.record(z.unknown()).default({}),
});

/**
 * PUT /api/v1/players/:playerId/consent/verify
 *
 * Completes a NON-redirect verification (mock in development, manual offline at
 * the ground). DigiLocker never comes through here — its exchange happens in
 * the provider callback, because the client secret must not leave the server.
 */
export const PUT = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, completeSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, params.playerId);

  const result = await completeVerification({
    requestId: body.requestId,
    accountId: actor.accountId,
    playerProfileId: params.playerId,
    payload: body.payload,
    context,
  });

  return ok({
    requestId: body.requestId,
    verified: result.verified,
    method: result.method,
    verifiedAt: result.verifiedAt,
    note: result.note ?? null,
  });
});
