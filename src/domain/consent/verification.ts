/**
 * Verifiable parent identity — pluggable.
 *
 * Spec 2.3: "Verifiable parent identity is required. DigiLocker is the path the
 * rules point to. Build the verification method as a pluggable step so it can
 * be swapped."
 *
 * Contract every verifier must honour:
 *   - It returns an OPAQUE reference, never identity document contents. We must
 *     be able to prove verification happened without ourselves holding an
 *     Aadhaar number or a scan of one.
 *   - It is a two-step handshake (start → complete) so redirect-based flows fit
 *     without the interface bending around them.
 */

import { randomUUID, createHash } from 'node:crypto';
import { env } from '@/lib/env';

export type VerificationMethod = 'DIGILOCKER' | 'MOCK' | 'MANUAL_OFFLINE';

export interface VerificationStart {
  /** Correlates the start and complete calls. */
  requestId: string;
  /** Where to send the parent, for redirect-based verifiers. */
  redirectUrl?: string;
  /** Instructions for verifiers with no redirect (e.g. manual offline). */
  instruction?: string;
  expiresAt: Date;
}

export interface VerificationResult {
  verified: boolean;
  method: VerificationMethod;
  /**
   * Opaque, non-reversible reference we can cite in an audit or a regulator
   * request. Must NOT be an identity number or contain one.
   */
  reference: string;
  verifiedAt: Date;
  /** Non-identifying detail for support, e.g. "name matched account holder". */
  note?: string;
}

export interface ParentVerifier {
  readonly method: VerificationMethod;
  start(params: { accountId: string; playerProfileId: string }): Promise<VerificationStart>;
  complete(params: {
    requestId: string;
    accountId: string;
    /** Verifier-specific payload — an OAuth code, an operator attestation, etc. */
    payload: Record<string, unknown>;
  }): Promise<VerificationResult>;
}

export class VerificationError extends Error {
  readonly method: VerificationMethod;

  constructor(method: VerificationMethod, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.method = method;
  }
}

/**
 * Build an opaque reference from provider data. Hashing means a leaked audit
 * table yields nothing about the parent's identity documents, while the same
 * verification still produces the same reference for reconciliation.
 */
function opaqueReference(method: VerificationMethod, providerId: string): string {
  const digest = createHash('sha256').update(`${method}:${providerId}`).digest('hex');
  return `${method.toLowerCase()}_${digest.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// DigiLocker
// ---------------------------------------------------------------------------

/**
 * DigiLocker OAuth2 flow. The integration is stubbed at the network boundary —
 * the real endpoints require a registered partner application, which is a
 * commercial onboarding step rather than a code one. Everything either side of
 * the HTTP call is complete, so wiring it up is a matter of filling in the two
 * marked calls.
 */
class DigiLockerVerifier implements ParentVerifier {
  readonly method = 'DIGILOCKER' as const;

  async start(params: { accountId: string; playerProfileId: string }): Promise<VerificationStart> {
    const config = env();
    if (!config.DIGILOCKER_CLIENT_ID || !config.DIGILOCKER_REDIRECT_URI) {
      throw new VerificationError('DIGILOCKER', 'DigiLocker is not configured on this deployment.');
    }

    const requestId = randomUUID();
    const state = Buffer.from(
      JSON.stringify({ requestId, accountId: params.accountId, playerProfileId: params.playerProfileId }),
    ).toString('base64url');

    const url = new URL('https://api.digitallocker.gov.in/public/oauth2/1/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.DIGILOCKER_CLIENT_ID);
    url.searchParams.set('redirect_uri', config.DIGILOCKER_REDIRECT_URI);
    url.searchParams.set('state', state);
    // Request only what proves the parent is who they say they are. Asking for
    // document contents we do not need would be a data-minimisation failure.
    url.searchParams.set('scope', 'basic_profile');

    return {
      requestId,
      redirectUrl: url.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  async complete(params: {
    requestId: string;
    accountId: string;
    payload: Record<string, unknown>;
  }): Promise<VerificationResult> {
    const code = params.payload.code;
    if (typeof code !== 'string' || !code) {
      throw new VerificationError('DIGILOCKER', 'Missing authorisation code from DigiLocker.');
    }

    // TODO(integration): exchange `code` for a token at
    //   POST https://api.digitallocker.gov.in/public/oauth2/1/token
    // then read the basic profile. Keep ONLY the stable subject identifier —
    // discard the name, DOB and any document payload once matched.
    throw new VerificationError(
      'DIGILOCKER',
      'DigiLocker token exchange is not wired up yet. Register the partner application and complete the two marked calls in DigiLockerVerifier.complete().',
    );
  }
}

// ---------------------------------------------------------------------------
// Mock (development only)
// ---------------------------------------------------------------------------

/**
 * Local development only. `env()` refuses to boot production with
 * CONSENT_VERIFIER=mock, because shipping this would mean shipping a consent
 * mechanism that verifies nothing.
 */
class MockVerifier implements ParentVerifier {
  readonly method = 'MOCK' as const;

  async start(params: { accountId: string; playerProfileId: string }): Promise<VerificationStart> {
    return {
      requestId: randomUUID(),
      instruction:
        'Development verifier: call complete with { "confirm": true } to simulate a successful parent identity check.',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  async complete(params: {
    requestId: string;
    accountId: string;
    payload: Record<string, unknown>;
  }): Promise<VerificationResult> {
    if (params.payload.confirm !== true) {
      throw new VerificationError('MOCK', 'Mock verification was not confirmed.');
    }
    return {
      verified: true,
      method: 'MOCK',
      reference: opaqueReference('MOCK', `${params.accountId}:${params.requestId}`),
      verifiedAt: new Date(),
      note: 'Development verifier — not a real identity check.',
    };
  }
}

// ---------------------------------------------------------------------------
// Manual offline
// ---------------------------------------------------------------------------

/**
 * The club verified a parent's ID in person. Legitimate for walk-in families,
 * but it moves the accountability onto a named staff member, so the record
 * requires who checked and what they saw — without storing the document.
 */
class ManualOfflineVerifier implements ParentVerifier {
  readonly method = 'MANUAL_OFFLINE' as const;

  async start(): Promise<VerificationStart> {
    return {
      requestId: randomUUID(),
      instruction:
        'A club administrator must confirm they have seen the parent’s photo identification in person.',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  async complete(params: {
    requestId: string;
    accountId: string;
    payload: Record<string, unknown>;
  }): Promise<VerificationResult> {
    const verifiedByAccountId = params.payload.verifiedByAccountId;
    const documentType = params.payload.documentType;

    if (typeof verifiedByAccountId !== 'string' || !verifiedByAccountId) {
      throw new VerificationError(
        'MANUAL_OFFLINE',
        'An offline verification must record which staff account performed it.',
      );
    }
    if (typeof documentType !== 'string' || !documentType) {
      throw new VerificationError(
        'MANUAL_OFFLINE',
        'Record which type of identification was seen (e.g. "voter ID", "passport") — never the number itself.',
      );
    }

    return {
      verified: true,
      method: 'MANUAL_OFFLINE',
      reference: opaqueReference('MANUAL_OFFLINE', `${params.accountId}:${verifiedByAccountId}:${params.requestId}`),
      verifiedAt: new Date(),
      note: `Photo ID of type "${documentType}" checked in person by staff account ${verifiedByAccountId}.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const VERIFIERS: Record<VerificationMethod, ParentVerifier> = {
  DIGILOCKER: new DigiLockerVerifier(),
  MOCK: new MockVerifier(),
  MANUAL_OFFLINE: new ManualOfflineVerifier(),
};

export function getVerifier(method: VerificationMethod): ParentVerifier {
  const verifier = VERIFIERS[method];
  if (!verifier) throw new VerificationError(method, `No verifier registered for "${method}".`);
  return verifier;
}

/** The verifier this deployment defaults to, per environment configuration. */
export function defaultVerifier(): ParentVerifier {
  return getVerifier(env().CONSENT_VERIFIER === 'digilocker' ? 'DIGILOCKER' : 'MOCK');
}
