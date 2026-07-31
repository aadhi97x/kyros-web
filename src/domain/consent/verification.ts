/**
 * Verifiable parent identity — pluggable adapters.
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
 *   - It performs NO database work. Tracking which requests are outstanding is
 *     `verification-store.ts`'s job; these adapters only talk to the provider.
 *     That split keeps the provider integration testable without Postgres, and
 *     keeps our own state machine testable without a provider.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

/** What the store hands an adapter when starting a flow. */
export interface StartContext {
  requestId: string;
  accountId: string;
  playerProfileId: string;
  /** PKCE S256 challenge. The verifier never sees the underlying secret. */
  codeChallenge?: string;
  /** Opaque value the provider must echo back on redirect. */
  stateToken: string;
  expiresAt: Date;
}

/** What the store hands an adapter when completing a flow. */
export interface CompleteContext {
  requestId: string;
  accountId: string;
  /** Verifier-specific payload — an OAuth code, an operator attestation, etc. */
  payload: Record<string, unknown>;
  /** PKCE verifier, replayed from storage. Never accepted from a client. */
  codeVerifier?: string;
  /** Account holder's name, used for a non-storing identity sanity check. */
  accountName?: string;
}

export interface ParentVerifier {
  readonly method: VerificationMethod;
  /** True when the parent must be sent to a provider and returns via callback. */
  readonly isRedirectFlow: boolean;
  start(context: StartContext): Promise<VerificationStart>;
  complete(context: CompleteContext): Promise<VerificationResult>;
}

export class VerificationError extends Error {
  readonly method: VerificationMethod;
  /** True when retrying could plausibly work (provider timeout, 5xx). */
  readonly retryable: boolean;

  constructor(method: VerificationMethod, message: string, retryable = false) {
    super(message);
    this.name = 'VerificationError';
    this.method = method;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * RFC 7636 S256. The verifier is stored server-side against the request; only
 * the challenge travels to the provider, so intercepting the redirect does not
 * let an attacker redeem the authorisation code.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createStateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Build an opaque reference from provider data. Hashing means a leaked audit
 * table yields nothing about the parent's identity, while the same person
 * verifying twice still produces the same reference for reconciliation.
 */
function opaqueReference(method: VerificationMethod, providerId: string): string {
  const digest = createHash('sha256').update(`${method}:${providerId}`).digest('hex');
  return `${method.toLowerCase()}_${digest.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// DigiLocker
// ---------------------------------------------------------------------------

/**
 * Shape of a successful DigiLocker token response.
 *
 * The provider returns the parent's name, date of birth and gender alongside
 * the token. We deliberately read `name` only to compute a match signal and
 * then discard it — none of this PII is persisted anywhere. `digilockerid` is
 * the stable subject identifier and is the only field that survives, hashed.
 */
interface DigiLockerTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  consent_valid_till?: string;
  digilockerid?: string;
  name?: string;
  dob?: string;
  gender?: string;
  /** "Y" when the DigiLocker account is Aadhaar-seeded — a stronger signal. */
  eaadhaar?: string;
  reference_key?: string;
  /** Present on failure. */
  error?: string;
  error_description?: string;
}

/**
 * Normalise a name for comparison: strip honorifics, punctuation and case, and
 * collapse whitespace. Indian names transliterate inconsistently, so this is a
 * deliberately loose signal recorded as context for a human — never a hard gate.
 */
function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|shri|smt|kum)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Do the two names share a meaningful token? Loose by design. */
function namesPlausiblyMatch(a: string, b: string): boolean {
  const left = new Set(normaliseName(a).split(' ').filter((part) => part.length > 2));
  const right = normaliseName(b).split(' ').filter((part) => part.length > 2);
  return right.some((part) => left.has(part));
}

class DigiLockerVerifier implements ParentVerifier {
  readonly method = 'DIGILOCKER' as const;
  readonly isRedirectFlow = true;

  private authorizeUrl(): string {
    return env().DIGILOCKER_AUTHORIZE_URL;
  }

  private tokenUrl(): string {
    return env().DIGILOCKER_TOKEN_URL;
  }

  async start(context: StartContext): Promise<VerificationStart> {
    const config = env();

    if (!config.DIGILOCKER_CLIENT_ID || !config.DIGILOCKER_REDIRECT_URI) {
      throw new VerificationError(
        'DIGILOCKER',
        'DigiLocker is not configured on this deployment. Set DIGILOCKER_CLIENT_ID, DIGILOCKER_CLIENT_SECRET and DIGILOCKER_REDIRECT_URI.',
      );
    }
    if (!context.codeChallenge) {
      throw new VerificationError('DIGILOCKER', 'A PKCE challenge is required for DigiLocker.');
    }

    const url = new URL(this.authorizeUrl());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.DIGILOCKER_CLIENT_ID);
    url.searchParams.set('redirect_uri', config.DIGILOCKER_REDIRECT_URI);
    url.searchParams.set('state', context.stateToken);
    url.searchParams.set('code_challenge', context.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Data minimisation: we need to know the parent is a real, verified adult.
    // We do not need — and must not request — the contents of their documents.
    url.searchParams.set('scope', 'basic_profile');

    return {
      requestId: context.requestId,
      redirectUrl: url.toString(),
      expiresAt: context.expiresAt,
    };
  }

  async complete(context: CompleteContext): Promise<VerificationResult> {
    const config = env();
    const code = context.payload.code;

    if (typeof code !== 'string' || !code) {
      throw new VerificationError('DIGILOCKER', 'Missing authorisation code from DigiLocker.');
    }
    if (!config.DIGILOCKER_CLIENT_ID || !config.DIGILOCKER_CLIENT_SECRET || !config.DIGILOCKER_REDIRECT_URI) {
      throw new VerificationError('DIGILOCKER', 'DigiLocker credentials are not configured.');
    }
    if (!context.codeVerifier) {
      throw new VerificationError(
        'DIGILOCKER',
        'The PKCE verifier for this request is missing. Start the verification again.',
      );
    }

    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: config.DIGILOCKER_CLIENT_ID,
      client_secret: config.DIGILOCKER_CLIENT_SECRET,
      redirect_uri: config.DIGILOCKER_REDIRECT_URI,
      code_verifier: context.codeVerifier,
    });

    let response: Response;
    try {
      response = await fetch(this.tokenUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        // A hung government endpoint must not hold our request open forever.
        signal: AbortSignal.timeout(config.DIGILOCKER_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new VerificationError(
        'DIGILOCKER',
        timedOut
          ? 'DigiLocker did not respond in time. Please try again.'
          : 'Could not reach DigiLocker. Please try again.',
        true,
      );
    }

    let payload: DigiLockerTokenResponse;
    try {
      payload = (await response.json()) as DigiLockerTokenResponse;
    } catch {
      throw new VerificationError(
        'DIGILOCKER',
        `DigiLocker returned a non-JSON response (HTTP ${response.status}).`,
        response.status >= 500,
      );
    }

    if (!response.ok || payload.error) {
      // `error_description` is provider diagnostics, not user data — safe to
      // surface. The rest of the body is not, so it is never logged.
      throw new VerificationError(
        'DIGILOCKER',
        payload.error_description ??
          payload.error ??
          `DigiLocker rejected the verification (HTTP ${response.status}).`,
        response.status >= 500,
      );
    }

    const subject = payload.digilockerid;
    if (!subject) {
      // Log the KEY NAMES only. The values are the parent's identity data and
      // must never reach a log file — but an integrator hitting a changed API
      // needs to see the shape to fix it.
      console.error(
        '[digilocker] token response had no `digilockerid`. Keys present:',
        Object.keys(payload).join(', '),
      );
      throw new VerificationError(
        'DIGILOCKER',
        'DigiLocker did not return an account identifier. Check the partner API contract.',
      );
    }

    // Derive the match signal, then let the PII fall out of scope. Nothing
    // below this line touches `payload.name`, `payload.dob` or `payload.gender`.
    const aadhaarSeeded = payload.eaadhaar === 'Y' || payload.eaadhaar === 'y';
    const nameMatches =
      context.accountName && payload.name
        ? namesPlausiblyMatch(context.accountName, payload.name)
        : null;

    const notes = [
      aadhaarSeeded ? 'Aadhaar-seeded DigiLocker account' : 'DigiLocker account (not Aadhaar-seeded)',
    ];
    if (nameMatches === true) notes.push('name matched the account holder');
    if (nameMatches === false) notes.push('name did NOT match the account holder — review');

    return {
      verified: true,
      method: 'DIGILOCKER',
      reference: opaqueReference('DIGILOCKER', subject),
      verifiedAt: new Date(),
      note: notes.join('; '),
    };
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
  readonly isRedirectFlow = false;

  async start(context: StartContext): Promise<VerificationStart> {
    return {
      requestId: context.requestId,
      instruction:
        'Development verifier: submit the consent with { "confirm": true } as the verification payload to simulate a successful parent identity check.',
      expiresAt: context.expiresAt,
    };
  }

  async complete(context: CompleteContext): Promise<VerificationResult> {
    if (context.payload.confirm !== true) {
      throw new VerificationError('MOCK', 'Mock verification was not confirmed.');
    }
    return {
      verified: true,
      method: 'MOCK',
      reference: opaqueReference('MOCK', `${context.accountId}:${context.requestId}`),
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
  readonly isRedirectFlow = false;

  async start(context: StartContext): Promise<VerificationStart> {
    return {
      requestId: context.requestId,
      instruction:
        'A club administrator must confirm they have seen the parent’s photo identification in person.',
      expiresAt: context.expiresAt,
    };
  }

  async complete(context: CompleteContext): Promise<VerificationResult> {
    const verifiedByAccountId = context.payload.verifiedByAccountId;
    const documentType = context.payload.documentType;

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
      reference: opaqueReference(
        'MANUAL_OFFLINE',
        `${context.accountId}:${verifiedByAccountId}:${context.requestId}`,
      ),
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

/** Exposed for the store, which needs an id before calling `start`. */
export function newRequestId(): string {
  return randomUUID();
}

/** Exported for tests — the loose name comparison is worth pinning down. */
export const __testing = { normaliseName, namesPlausiblyMatch, opaqueReference };
