/**
 * Environment access.
 *
 * Everything server-side reads config from here, never `process.env` directly,
 * so that a missing or malformed variable fails loudly at boot rather than
 * mysteriously at 2am. Nothing in this file may be imported from a client
 * component — the values include secrets.
 */

import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.string().default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters — generate one with crypto.randomBytes(48)'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000),

  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(45),
  OTP_DEV_MODE: booleanish.default(true),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_CURRENCY: z.string().default('INR'),
  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000),

  CONSENT_VERIFIER: z.enum(['mock', 'digilocker']).default('mock'),
  DIGILOCKER_CLIENT_ID: z.string().optional(),
  DIGILOCKER_CLIENT_SECRET: z.string().optional(),
  DIGILOCKER_REDIRECT_URI: z.string().optional(),
  // Endpoints are configurable so the sandbox can be pointed at without a code
  // change — the partner sandbox and production hosts differ.
  DIGILOCKER_AUTHORIZE_URL: z
    .string()
    .url()
    .default('https://api.digitallocker.gov.in/public/oauth2/1/authorize'),
  DIGILOCKER_TOKEN_URL: z
    .string()
    .url()
    .default('https://api.digitallocker.gov.in/public/oauth2/1/token'),
  DIGILOCKER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /** Deep link the callback bounces the parent back into the app with. */
  APP_DEEP_LINK_SCHEME: z.string().default('kyros'),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}\n\nSee .env.example.`);
  }

  const value = parsed.data;

  // Guards that only matter in production, where getting them wrong is a real
  // incident rather than an inconvenience.
  if (value.NODE_ENV === 'production') {
    if (value.OTP_DEV_MODE) {
      throw new Error('OTP_DEV_MODE must be false in production — OTPs would be written to logs.');
    }
    if (value.CONSENT_VERIFIER === 'mock') {
      throw new Error(
        'CONSENT_VERIFIER=mock cannot ship. DPDP requires verifiable parent identity — use digilocker.',
      );
    }
    if (!value.RAZORPAY_KEY_SECRET || !value.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('Razorpay credentials are required in production.');
    }
  }

  cached = value;
  return value;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}

/** Test-only escape hatch so a suite can rebuild the cache after mutating env. */
export function resetEnvCache(): void {
  cached = null;
}
