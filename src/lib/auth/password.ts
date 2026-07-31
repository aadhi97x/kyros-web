import bcrypt from 'bcryptjs';

/**
 * Cost 12 is the current sensible floor for bcrypt: ~250ms on commodity
 * hardware, which is slow enough to matter to an attacker and fast enough that
 * a login does not feel broken.
 */
const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Constant-ish-time dummy comparison, run when an account does not exist, so
 * that "unknown phone" and "wrong password" take the same wall-clock time and
 * cannot be told apart by an enumeration attack.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO1J1jHqL0aVjFqZbXvPLLWQ9kK4NnW7C';

export async function burnPasswordTime(): Promise<void> {
  await bcrypt.compare('not-a-real-password', DUMMY_HASH);
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Deliberately modest: length carries the weight, character-class rules mostly
 * push people towards `Password1!`. The blocklist catches the handful of
 * passwords that actually show up in credential-stuffing lists.
 */
const COMMON = new Set([
  'password',
  'password1',
  '12345678',
  '123456789',
  'qwerty123',
  'football',
  'india123',
  'welcome1',
  'iloveyou',
  'admin123',
]);

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < 8) problems.push('Use at least 8 characters.');
  if (password.length > 128) problems.push('Use no more than 128 characters.');
  if (COMMON.has(password.toLowerCase())) problems.push('That password is too common.');
  if (/^\d+$/.test(password)) problems.push('Use more than just digits.');

  return { ok: problems.length === 0, problems };
}
