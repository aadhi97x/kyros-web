/**
 * Append-only audit log.
 *
 * Spec 8: "audit logging, especially for consent events (how and when consent
 * was obtained)". Nothing in this file ever updates or deletes a row.
 *
 * Redaction matters: an audit trail that stores the thing it is auditing
 * (an identity document, a card number) is a liability, not a control.
 */

import type { NextRequest } from 'next/server';
import { prisma } from './db';

export type AuditAction =
  // Consent — legally load-bearing
  | 'consent.granted'
  | 'consent.withdrawn'
  | 'consent.verification_started'
  | 'consent.verification_succeeded'
  | 'consent.verification_failed'
  // Accounts
  | 'account.created'
  | 'account.verified'
  | 'account.login'
  | 'account.login_failed'
  | 'account.erasure_requested'
  | 'account.erased'
  | 'player.created'
  | 'player.updated'
  | 'player.archived'
  // Club
  | 'club.created'
  | 'club.config_updated'
  | 'club.published'
  | 'club.suspended'
  // Enrollment & lifecycle
  | 'membership.created'
  | 'membership.approved'
  | 'membership.rejected'
  | 'membership.paused'
  | 'membership.resumed'
  | 'membership.cancelled'
  | 'membership.upgraded'
  | 'waitlist.joined'
  | 'waitlist.promoted'
  | 'waitlist.removed'
  // Money
  | 'payment.created'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.refunded'
  | 'wallet.credited'
  | 'wallet.debited'
  // Operations
  | 'attendance.marked'
  | 'attendance.edited'
  | 'coach.checked_in'
  | 'booking.held'
  | 'booking.confirmed'
  | 'booking.cancelled';

export interface AuditContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Field names whose values must never reach the audit table. */
const REDACT_KEYS = new Set([
  'password',
  'passwordhash',
  'code',
  'codehash',
  'otp',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'signature',
  'aadhaar',
  'aadhar',
  'pan',
  'cardnumber',
  'cvv',
  'accountnumber',
  'ifsc',
  'medicalnotes',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

export async function audit(params: {
  action: AuditAction;
  entityType: string;
  entityId: string;
  actorAccountId?: string | null;
  metadata?: Record<string, unknown>;
  context?: AuditContext;
}): Promise<void> {
  const { action, entityType, entityId, actorAccountId, metadata, context } = params;

  try {
    await prisma.auditEvent.create({
      data: {
        action,
        entityType,
        entityId,
        actorAccountId: actorAccountId ?? null,
        metadata: metadata ? (redact(metadata) as object) : undefined,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      },
    });
  } catch (error) {
    // An audit failure must not take down the operation being audited, but it
    // must be loud — a silently missing consent trail is a compliance problem.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write event', { action, entityType, entityId, error });
  }
}

/** Pull the client identifiers off a request for the audit trail. */
export function auditContextFrom(request: NextRequest): AuditContext {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ipAddress: forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip'),
    userAgent: request.headers.get('user-agent'),
  };
}
