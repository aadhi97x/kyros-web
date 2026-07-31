import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok, noContent } from '@/lib/api/response';
import { parseBody, route } from '@/lib/api/handler';
import { hashRefreshToken, issueRefreshToken, signAccessToken } from '@/lib/auth/jwt';

const bodySchema = z.object({ refreshToken: z.string().min(20) });

/**
 * POST /api/v1/auth/refresh
 *
 * Rotating refresh tokens: each use issues a new one and revokes the old. If a
 * revoked token is presented again the whole family is killed, because that
 * means either a replay or a stolen token.
 */
export const POST = route(async ({ request }) => {
  const { refreshToken } = await parseBody(request, bodySchema);
  const tokenHash = hashRefreshToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { id: true, accountId: true, deviceId: true, expiresAt: true, revokedAt: true },
  });

  if (!stored) throw ApiError.unauthenticated('Session not recognised. Sign in again.');

  if (stored.revokedAt) {
    // Reuse of a rotated token: assume compromise and end every session.
    await prisma.refreshToken.updateMany({
      where: { accountId: stored.accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthenticated('This session was already used. Sign in again.');
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthenticated('Your session expired. Sign in again.');
  }

  const account = await prisma.account.findUnique({
    where: { id: stored.accountId },
    select: {
      id: true,
      role: true,
      status: true,
      clubsOwned: { select: { id: true } },
      coachProfiles: { where: { isActive: true }, select: { id: true } },
      venuesOwned: { select: { id: true } },
    },
  });

  if (!account || account.status !== 'ACTIVE') {
    throw ApiError.unauthenticated('This account is no longer active.');
  }

  const next = issueRefreshToken();

  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: {
        accountId: account.id,
        tokenHash: next.hash,
        deviceId: stored.deviceId,
        expiresAt: next.expiresAt,
      },
    }),
  ]);

  const accessToken = await signAccessToken({
    sub: account.id,
    role: account.role,
    coachId: account.coachProfiles[0]?.id,
    clubIds: account.clubsOwned.map((club) => club.id),
    venueIds: account.venuesOwned.map((venue) => venue.id),
  });

  return ok({ accessToken, refreshToken: next.token, expiresAt: next.expiresAt });
});

/** DELETE /api/v1/auth/refresh — sign out this device. */
export const DELETE = route(async ({ request }) => {
  const { refreshToken } = await parseBody(request, bodySchema);
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return noContent();
});
