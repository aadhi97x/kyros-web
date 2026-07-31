/**
 * Resolving "who is calling" from a request.
 *
 * Every authenticated route handler starts here. The claims in the JWT are a
 * fast path, but anything that grants access to another party's data is
 * re-checked against the database — a token minted before a coach was removed
 * from a club must not still open that club's roster.
 */

import type { NextRequest } from 'next/server';
import { prisma } from '../db';
import { ApiError } from '../api/errors';
import { extractBearerToken, verifyAccessToken, type TokenRole } from './jwt';

export interface Actor {
  accountId: string;
  role: TokenRole;
  name: string;
  phone: string;
  /** Coach record ids this account is attached to. */
  coachIds: string[];
  /** Clubs this account owns. */
  ownedClubIds: string[];
  /** Clubs this account coaches at. */
  coachedClubIds: string[];
  venueIds: string[];
  isPlatformAdmin: boolean;
}

export async function authenticate(request: NextRequest): Promise<Actor> {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) throw ApiError.unauthenticated();

  const claims = await verifyAccessToken(token);

  const account = await prisma.account.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      status: true,
      clubsOwned: { select: { id: true } },
      coachProfiles: { select: { id: true, clubId: true, isActive: true } },
      venuesOwned: { select: { id: true } },
    },
  });

  if (!account) throw ApiError.unauthenticated('This account no longer exists.');

  if (account.status === 'SUSPENDED') {
    throw ApiError.forbidden('This account is suspended. Contact support.');
  }
  if (account.status === 'ERASED' || account.status === 'ERASURE_REQUESTED') {
    throw ApiError.forbidden('This account is being erased and can no longer be used.');
  }
  if (account.status === 'PENDING_VERIFICATION') {
    throw ApiError.forbidden('Verify your phone number to continue.');
  }

  const activeCoachRecords = account.coachProfiles.filter((coach) => coach.isActive);

  return {
    accountId: account.id,
    role: account.role,
    name: account.name,
    phone: account.phone,
    coachIds: activeCoachRecords.map((coach) => coach.id),
    ownedClubIds: account.clubsOwned.map((club) => club.id),
    coachedClubIds: [...new Set(activeCoachRecords.map((coach) => coach.clubId))],
    venueIds: account.venuesOwned.map((venue) => venue.id),
    isPlatformAdmin: account.role === 'PLATFORM_ADMIN',
  };
}

/** For endpoints that behave differently for signed-in vs anonymous callers. */
export async function authenticateOptional(request: NextRequest): Promise<Actor | null> {
  if (!extractBearerToken(request.headers.get('authorization'))) return null;
  try {
    return await authenticate(request);
  } catch {
    return null;
  }
}
