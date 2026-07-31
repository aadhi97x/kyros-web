import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { parseBody, route } from '@/lib/api/handler';
import { normalisePhone, verifyOtp } from '@/lib/auth/otp';
import { issueRefreshToken, signAccessToken } from '@/lib/auth/jwt';
import { audit, auditContextFrom } from '@/lib/audit';

const bodySchema = z.object({
  phone: z.string().trim(),
  code: z.string().trim().length(6),
  purpose: z.enum(['signup', 'login', 'claim']).default('signup'),
  /** Spec 2.1: the parent-vs-adult-player choice, made right after verifying. */
  accountType: z.enum(['GUARDIAN', 'ADULT_PLAYER']).optional(),
  deviceId: z.string().max(200).optional(),
});

/**
 * POST /api/v1/auth/verify
 *
 * Confirms the OTP and issues a session. Also where a COACH_CREATED account
 * gets claimed by the family (spec 2.1, third entry door).
 */
export const POST = route(async ({ request }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);
  const phone = normalisePhone(body.phone);

  await verifyOtp({ destination: phone, purpose: body.purpose, code: body.code });

  const account = await prisma.account.findUnique({
    where: { phone },
    select: { id: true, name: true, phone: true, role: true, type: true, status: true, origin: true },
  });

  if (!account) throw ApiError.notFound('Account');

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: {
      status: account.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : account.status,
      phoneVerifiedAt: new Date(),
      lastLoginAt: new Date(),
      ...(body.accountType ? { type: body.accountType } : {}),
      ...(body.purpose === 'claim' ? { claimedAt: new Date(), claimToken: null } : {}),
    },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      type: true,
      status: true,
      clubsOwned: { select: { id: true } },
      coachProfiles: { where: { isActive: true }, select: { id: true } },
      venuesOwned: { select: { id: true } },
    },
  });

  const refresh = issueRefreshToken();
  await prisma.refreshToken.create({
    data: {
      accountId: updated.id,
      tokenHash: refresh.hash,
      deviceId: body.deviceId,
      expiresAt: refresh.expiresAt,
    },
  });

  const accessToken = await signAccessToken({
    sub: updated.id,
    role: updated.role,
    coachId: updated.coachProfiles[0]?.id,
    clubIds: updated.clubsOwned.map((club) => club.id),
    venueIds: updated.venuesOwned.map((venue) => venue.id),
  });

  await audit({
    action: body.purpose === 'claim' ? 'account.verified' : 'account.verified',
    entityType: 'Account',
    entityId: updated.id,
    actorAccountId: updated.id,
    metadata: { purpose: body.purpose },
    context,
  });

  return ok({
    accessToken,
    refreshToken: refresh.token,
    expiresAt: refresh.expiresAt,
    account: {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      role: updated.role,
      type: updated.type,
      // The app routes to the profile-type chooser when this is still UNSET.
      needsAccountType: updated.type === 'UNSET',
    },
  });
});
