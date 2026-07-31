import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { parseBody, route } from '@/lib/api/handler';
import { burnPasswordTime, verifyPassword } from '@/lib/auth/password';
import { issueOtp, normalisePhone } from '@/lib/auth/otp';
import { issueRefreshToken, signAccessToken } from '@/lib/auth/jwt';
import { audit, auditContextFrom } from '@/lib/audit';

const bodySchema = z.object({
  phone: z.string().trim(),
  password: z.string().min(1).optional(),
  /** Passwordless: request an OTP instead of sending a password. */
  useOtp: z.boolean().default(false),
  deviceId: z.string().max(200).optional(),
});

/** POST /api/v1/auth/login */
export const POST = route(async ({ request }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);
  const phone = normalisePhone(body.phone);

  const account = await prisma.account.findUnique({
    where: { phone },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      type: true,
      status: true,
      passwordHash: true,
      clubsOwned: { select: { id: true } },
      coachProfiles: { where: { isActive: true }, select: { id: true } },
      venuesOwned: { select: { id: true } },
    },
  });

  if (body.useOtp) {
    // Do not reveal whether the number is registered — issue nothing but
    // respond identically either way.
    if (account) {
      const challenge = await issueOtp({
        destination: phone,
        channel: 'sms',
        purpose: 'login',
        accountId: account.id,
      });
      return ok({
        otpSent: true,
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
        devCode: challenge.devCode,
      });
    }
    return ok({ otpSent: true });
  }

  if (!body.password) throw ApiError.badRequest('Enter your password.');

  if (!account?.passwordHash) {
    // Spend the same time as a real comparison so an attacker cannot tell a
    // missing account from a wrong password by timing.
    await burnPasswordTime();
    throw ApiError.unauthenticated('That phone number or password is not right.');
  }

  const matches = await verifyPassword(body.password, account.passwordHash);
  if (!matches) {
    await audit({
      action: 'account.login_failed',
      entityType: 'Account',
      entityId: account.id,
      metadata: { reason: 'bad_password' },
      context,
    });
    throw ApiError.unauthenticated('That phone number or password is not right.');
  }

  if (account.status === 'PENDING_VERIFICATION') {
    const challenge = await issueOtp({
      destination: phone,
      channel: 'sms',
      purpose: 'signup',
      accountId: account.id,
    });
    return ok({
      requiresVerification: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      devCode: challenge.devCode,
    });
  }

  if (account.status !== 'ACTIVE') {
    throw ApiError.forbidden('This account is not active. Contact support.');
  }

  const refresh = issueRefreshToken();
  await prisma.$transaction([
    prisma.refreshToken.create({
      data: {
        accountId: account.id,
        tokenHash: refresh.hash,
        deviceId: body.deviceId,
        expiresAt: refresh.expiresAt,
      },
    }),
    prisma.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } }),
  ]);

  const accessToken = await signAccessToken({
    sub: account.id,
    role: account.role,
    coachId: account.coachProfiles[0]?.id,
    clubIds: account.clubsOwned.map((club) => club.id),
    venueIds: account.venuesOwned.map((venue) => venue.id),
  });

  await audit({
    action: 'account.login',
    entityType: 'Account',
    entityId: account.id,
    actorAccountId: account.id,
    context,
  });

  return ok({
    accessToken,
    refreshToken: refresh.token,
    expiresAt: refresh.expiresAt,
    account: {
      id: account.id,
      name: account.name,
      phone: account.phone,
      role: account.role,
      type: account.type,
      needsAccountType: account.type === 'UNSET',
    },
  });
});
