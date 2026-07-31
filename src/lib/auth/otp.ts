/**
 * Phone/email OTP.
 *
 * Only the hash of a code is ever persisted, attempts are counted server-side,
 * and codes are single-use. In dev mode the code is logged rather than sent so
 * there is no SMS bill during development — `env()` refuses to boot production
 * with dev mode on.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { prisma } from '../db';
import { ApiError } from '../api/errors';

export type OtpPurpose = 'signup' | 'login' | 'phone_change' | 'claim';
export type OtpChannel = 'sms' | 'email';

const CODE_LENGTH = 6;

function generateCode(): string {
  // randomInt is CSPRNG-backed; Math.random is not, and an OTP is a credential.
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

function hashCode(code: string, destination: string): string {
  // Salting with the destination stops one leaked table row being replayed
  // against a different phone number.
  return createHash('sha256').update(`${destination}:${code}`).digest('hex');
}

export interface OtpIssueResult {
  challengeId: string;
  expiresAt: Date;
  /** Only populated in dev mode, so the client can auto-fill during testing. */
  devCode?: string;
}

export async function issueOtp(params: {
  destination: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  accountId?: string;
}): Promise<OtpIssueResult> {
  const { destination, channel, purpose, accountId } = params;
  const config = env();

  // Rate limit: refuse a fresh code while the previous one is still young.
  const recent = await prisma.otpChallenge.findFirst({
    where: { destination, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (recent) {
    const ageSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (ageSeconds < config.OTP_RESEND_COOLDOWN_SECONDS) {
      throw new ApiError(
        'RATE_LIMITED',
        `Wait ${Math.ceil(config.OTP_RESEND_COOLDOWN_SECONDS - ageSeconds)}s before requesting another code.`,
      );
    }
    // Supersede the old challenge so only one code is ever live.
    await prisma.otpChallenge.update({
      where: { id: recent.id },
      data: { consumedAt: new Date() },
    });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.OTP_TTL_SECONDS * 1000);

  const challenge = await prisma.otpChallenge.create({
    data: {
      accountId,
      destination,
      channel,
      codeHash: hashCode(code, destination),
      purpose,
      maxAttempts: config.OTP_MAX_ATTEMPTS,
      expiresAt,
    },
  });

  await deliverOtp(destination, channel, code);

  return {
    challengeId: challenge.id,
    expiresAt,
    ...(config.OTP_DEV_MODE ? { devCode: code } : {}),
  };
}

async function deliverOtp(destination: string, channel: OtpChannel, code: string): Promise<void> {
  if (env().OTP_DEV_MODE) {
    console.info(`[otp:dev] ${channel} → ${destination}: ${code}`);
    return;
  }

  // Wire a real provider here (MSG91 is the usual choice for India — DLT
  // template registration is mandatory for transactional SMS).
  throw ApiError.internal('No SMS provider configured. Set SMS_PROVIDER and credentials.');
}

export async function verifyOtp(params: {
  destination: string;
  purpose: OtpPurpose;
  code: string;
}): Promise<{ accountId: string | null }> {
  const { destination, purpose, code } = params;

  const challenge = await prisma.otpChallenge.findFirst({
    where: { destination, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!challenge) {
    throw new ApiError('OTP_INVALID', 'No verification code is pending for this number.');
  }

  if (challenge.expiresAt.getTime() < Date.now()) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw new ApiError('OTP_EXPIRED', 'That code has expired. Request a new one.');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    throw new ApiError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
  }

  const expected = Buffer.from(challenge.codeHash, 'hex');
  const actual = Buffer.from(hashCode(code, destination), 'hex');
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    const remaining = challenge.maxAttempts - challenge.attempts - 1;
    throw new ApiError(
      'OTP_INVALID',
      remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
        : 'Incorrect code. Request a new one.',
    );
  }

  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  return { accountId: challenge.accountId };
}

/** Housekeeping for a nightly job — expired challenges are dead weight. */
export async function purgeExpiredOtps(): Promise<number> {
  const result = await prisma.otpChallenge.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Phone normalisation (India-first)
// ---------------------------------------------------------------------------

/**
 * Store one canonical form so `+91 98765 43210`, `09876543210` and
 * `9876543210` cannot become three accounts.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (input.startsWith('+')) return `+${digits}`;

  throw ApiError.badRequest('Enter a valid Indian mobile number.');
}

export function isValidIndianMobile(normalised: string): boolean {
  // Indian mobile numbers start 6–9 after the country code.
  return /^\+91[6-9]\d{9}$/.test(normalised);
}
