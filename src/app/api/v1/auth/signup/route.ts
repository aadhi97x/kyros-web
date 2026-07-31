import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { created } from '@/lib/api/response';
import { parseBody, route } from '@/lib/api/handler';
import { checkPasswordPolicy, hashPassword } from '@/lib/auth/password';
import { isValidIndianMobile, issueOtp, normalisePhone } from '@/lib/auth/otp';
import { audit, auditContextFrom } from '@/lib/audit';

const bodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(6).max(20),
  email: z.string().trim().email().max(200).optional(),
  password: z.string().min(8).max(128),
  /** Spec 2.1 — chosen after verification, but accepted here if already known. */
  accountType: z.enum(['GUARDIAN', 'ADULT_PLAYER']).optional(),
});

/**
 * POST /api/v1/auth/signup
 *
 * Spec 2.1: sign up with name, phone, email, password, then OTP verification.
 * The account exists in PENDING_VERIFICATION until the OTP is confirmed, so an
 * abandoned signup cannot log in.
 */
export const POST = route(async ({ request }) => {
  const body = await parseBody(request, bodySchema);
  const context = auditContextFrom(request);

  const phone = normalisePhone(body.phone);
  if (!isValidIndianMobile(phone)) {
    throw ApiError.badRequest('Enter a valid Indian mobile number.');
  }

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) {
    throw ApiError.badRequest(policy.problems.join(' '), { problems: policy.problems });
  }

  const existing = await prisma.account.findUnique({
    where: { phone },
    select: { id: true, status: true, origin: true, claimedAt: true },
  });

  if (existing) {
    // Spec 2.1 third door: a coach registered this family as a walk-in and the
    // family is now claiming the login. That is a claim, not a duplicate.
    if (existing.origin === 'COACH_CREATED' && existing.claimedAt === null) {
      const challenge = await issueOtp({
        destination: phone,
        channel: 'sms',
        purpose: 'claim',
        accountId: existing.id,
      });
      return created({
        accountId: existing.id,
        requiresClaim: true,
        otp: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, devCode: challenge.devCode },
        message: 'This number was registered by a club. Verify it to claim the account.',
      });
    }

    if (existing.status === 'PENDING_VERIFICATION') {
      const challenge = await issueOtp({
        destination: phone,
        channel: 'sms',
        purpose: 'signup',
        accountId: existing.id,
      });
      return created({
        accountId: existing.id,
        requiresClaim: false,
        otp: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, devCode: challenge.devCode },
        message: 'We sent you a new verification code.',
      });
    }

    throw ApiError.conflict('An account already exists for this number. Sign in instead.');
  }

  const account = await prisma.account.create({
    data: {
      name: body.name,
      phone,
      email: body.email,
      passwordHash: await hashPassword(body.password),
      role: 'MEMBER',
      type: body.accountType ?? 'UNSET',
      status: 'PENDING_VERIFICATION',
      origin: body.accountType === 'ADULT_PLAYER' ? 'ADULT_SIGNUP' : 'GUARDIAN_SIGNUP',
    },
    select: { id: true },
  });

  const challenge = await issueOtp({
    destination: phone,
    channel: 'sms',
    purpose: 'signup',
    accountId: account.id,
  });

  await audit({
    action: 'account.created',
    entityType: 'Account',
    entityId: account.id,
    actorAccountId: account.id,
    metadata: { origin: body.accountType ?? 'UNSET' },
    context,
  });

  return created({
    accountId: account.id,
    requiresClaim: false,
    otp: {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      devCode: challenge.devCode,
    },
  });
});
