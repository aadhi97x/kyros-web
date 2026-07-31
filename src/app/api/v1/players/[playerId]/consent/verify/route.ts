import { z } from 'zod';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { defaultVerifier, getVerifier } from '@/domain/consent/verification';
import { audit, auditContextFrom } from '@/lib/audit';

type Params = { playerId: string };

const bodySchema = z.object({
  method: z.enum(['DIGILOCKER', 'MOCK', 'MANUAL_OFFLINE']).optional(),
});

/**
 * POST /api/v1/players/:playerId/consent/verify
 *
 * Starts the parent-identity handshake (spec 2.3). Returns either a redirect
 * URL (DigiLocker) or an instruction (offline), plus the requestId that must be
 * quoted when the grant is submitted.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, params.playerId);

  const verifier = body.method ? getVerifier(body.method) : defaultVerifier();
  const start = await verifier.start({
    accountId: actor.accountId,
    playerProfileId: params.playerId,
  });

  await audit({
    action: 'consent.verification_started',
    entityType: 'PlayerProfile',
    entityId: params.playerId,
    actorAccountId: actor.accountId,
    metadata: { method: verifier.method, requestId: start.requestId },
    context,
  });

  return ok({
    method: verifier.method,
    requestId: start.requestId,
    redirectUrl: start.redirectUrl ?? null,
    instruction: start.instruction ?? null,
    expiresAt: start.expiresAt,
  });
});
