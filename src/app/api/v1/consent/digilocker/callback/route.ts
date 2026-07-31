import { NextResponse } from 'next/server';
import { route } from '@/lib/api/handler';
import { env } from '@/lib/env';
import { completeVerification, findByStateToken } from '@/domain/consent/verification-store';
import { auditContextFrom } from '@/lib/audit';

/**
 * GET /api/v1/consent/digilocker/callback
 *
 * Where DigiLocker sends the parent after they authorise. Deliberately
 * UNAUTHENTICATED — the request arrives from the provider's redirect, which
 * carries no session. What makes it safe is the `state` token: 32 random bytes
 * that only this server and the provider have seen, minted per request and
 * bound to one account and one child.
 *
 * The token exchange happens here rather than in the app because the client
 * secret must never leave the server. The app only learns "verification N
 * succeeded" and quotes that requestId when it submits the consent.
 *
 * Always redirects — never returns JSON. A human is looking at this in a
 * browser, so every outcome has to land them back in the app.
 */
export const GET = route(async ({ request }) => {
  const params = request.nextUrl.searchParams;
  const code = params.get('code');
  const stateToken = params.get('state');
  const providerError = params.get('error');
  const context = auditContextFrom(request);

  const scheme = env().APP_DEEP_LINK_SCHEME;

  const backToApp = (query: Record<string, string>) => {
    const url = new URL(`${scheme}://consent-callback`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return NextResponse.redirect(url.toString(), { status: 302 });
  };

  // The parent declined, or DigiLocker refused. Not an error on our side.
  if (providerError) {
    return backToApp({
      status: 'cancelled',
      reason: params.get('error_description') ?? providerError,
    });
  }

  if (!stateToken || !code) {
    return backToApp({ status: 'failed', reason: 'The DigiLocker response was incomplete.' });
  }

  const pending = await findByStateToken(stateToken);
  if (!pending) {
    // An unknown state token means a forged or long-expired callback. Say as
    // little as possible.
    return backToApp({ status: 'failed', reason: 'This verification link is no longer valid.' });
  }

  try {
    await completeVerification({
      requestId: pending.id,
      accountId: pending.accountId,
      playerProfileId: pending.playerProfileId,
      payload: { code },
      context,
    });
  } catch (error) {
    return backToApp({
      status: 'failed',
      requestId: pending.id,
      reason: error instanceof Error ? error.message : 'Verification failed.',
    });
  }

  return backToApp({
    status: 'verified',
    requestId: pending.id,
    playerProfileId: pending.playerProfileId,
  });
});
