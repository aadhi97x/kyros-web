/**
 * Access-token issuing and verification.
 *
 * Short-lived stateless access tokens (JWT), long-lived opaque refresh tokens
 * stored hashed in Postgres. Revoking a session means deleting the refresh row;
 * the access token dies on its own within ACCESS_TOKEN_TTL.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env';
import { ApiError } from '../api/errors';

export type TokenRole = 'MEMBER' | 'CLUB_OWNER' | 'COACH' | 'VENUE_OWNER' | 'PLATFORM_ADMIN';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: TokenRole;
  /** Coach record id, when the caller is acting as a coach. */
  coachId?: string;
  /** Clubs this account owns, so RBAC can short-circuit the common case. */
  clubIds?: string[];
  venueIds?: string[];
}

const ISSUER = 'kyros';
const AUDIENCE = 'kyros-clients';

function secret(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET);
}

export async function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
): Promise<string> {
  const ttl = env().ACCESS_TOKEN_TTL;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttl}s`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
      throw ApiError.unauthenticated('Malformed token.');
    }
    return payload as AccessTokenClaims;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const expired =
      error instanceof Error && error.message.toLowerCase().includes('exp');
    throw new ApiError(
      expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED',
      expired ? 'Your session expired. Sign in again.' : 'Invalid session token.',
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface IssuedRefreshToken {
  /** Given to the client. Never stored. */
  token: string;
  /** Stored. A database leak yields no usable tokens. */
  hash: string;
  expiresAt: Date;
}

export function issueRefreshToken(): IssuedRefreshToken {
  const token = randomBytes(48).toString('base64url');
  return {
    token,
    hash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + env().REFRESH_TOKEN_TTL * 1000),
  };
}

export function hashRefreshToken(token: string): string {
  // SHA-256 rather than bcrypt: these are already 384 bits of entropy, so key
  // stretching buys nothing and would make every refresh cost 250ms.
  return createHash('sha256').update(token).digest('hex');
}

export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}
