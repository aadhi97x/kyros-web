/**
 * Role-based access control.
 *
 * Spec 1: "Role-based access control is enforced server-side, not just hidden
 * in the UI. Owner and coach share the same app binary; the dashboard renders
 * by role."
 *
 * The rules here are the authority. The mobile app's navigation is a
 * convenience, and is assumed to be lying.
 */

import { prisma } from '../db';
import { ApiError } from '../api/errors';
import type { Actor } from './session';

// ---------------------------------------------------------------------------
// Club scope
// ---------------------------------------------------------------------------

export type ClubAccess = 'OWNER' | 'COACH' | 'NONE';

export function clubAccessOf(actor: Actor, clubId: string): ClubAccess {
  if (actor.isPlatformAdmin) return 'OWNER';
  if (actor.ownedClubIds.includes(clubId)) return 'OWNER';
  if (actor.coachedClubIds.includes(clubId)) return 'COACH';
  return 'NONE';
}

/** Full club administration: config, packages, finances, coaches, analytics. */
export function assertClubOwner(actor: Actor, clubId: string): void {
  if (clubAccessOf(actor, clubId) !== 'OWNER') {
    throw ApiError.forbidden('Only the club owner can do that.');
  }
}

/** Anything a coach may also do: rosters, attendance, assessments, batch chat. */
export function assertClubStaff(actor: Actor, clubId: string): void {
  if (clubAccessOf(actor, clubId) === 'NONE') {
    throw ApiError.forbidden('You are not part of this club.');
  }
}

/**
 * A coach may only touch sessions for batches they are assigned to. Owners may
 * touch any batch in their own club.
 */
export async function assertCanManageBatch(actor: Actor, batchId: string): Promise<{ clubId: string }> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, coachId: true },
  });
  if (!batch) throw ApiError.notFound('Batch');

  const access = clubAccessOf(actor, batch.clubId);
  if (access === 'OWNER') return { clubId: batch.clubId };

  if (access === 'COACH') {
    if (batch.coachId && actor.coachIds.includes(batch.coachId)) {
      return { clubId: batch.clubId };
    }
    throw ApiError.forbidden('You are not assigned to this batch.');
  }

  throw ApiError.forbidden('You are not part of this club.');
}

export async function assertCanManageSession(
  actor: Actor,
  sessionId: string,
): Promise<{ clubId: string; batchId: string }> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, batchId: true, coachId: true, batch: { select: { clubId: true, coachId: true } } },
  });
  if (!session) throw ApiError.notFound('Session');

  const clubId = session.batch.clubId;
  const access = clubAccessOf(actor, clubId);
  if (access === 'OWNER') return { clubId, batchId: session.batchId };

  if (access === 'COACH') {
    const assigned =
      (session.coachId && actor.coachIds.includes(session.coachId)) ||
      (session.batch.coachId && actor.coachIds.includes(session.batch.coachId));
    if (assigned) return { clubId, batchId: session.batchId };
    throw ApiError.forbidden('You are not assigned to this session.');
  }

  throw ApiError.forbidden('You are not part of this club.');
}

// ---------------------------------------------------------------------------
// Member scope
// ---------------------------------------------------------------------------

/**
 * A player profile belongs to exactly one account. Only that account holder
 * may read or write it — plus club staff, and only for players enrolled with
 * their club, and only for the fields the club needs.
 */
export async function assertOwnsPlayerProfile(actor: Actor, playerProfileId: string): Promise<void> {
  const profile = await prisma.playerProfile.findUnique({
    where: { id: playerProfileId },
    select: { accountId: true },
  });
  if (!profile) throw ApiError.notFound('Player profile');
  if (profile.accountId !== actor.accountId && !actor.isPlatformAdmin) {
    throw ApiError.forbidden('That player profile belongs to another account.');
  }
}

/**
 * Club staff reading a member's record. Access is scoped to players who
 * actually have a membership (or a demo booking) with that club — a coach
 * cannot browse the whole platform's children.
 */
export async function assertCanViewPlayerAsClub(
  actor: Actor,
  playerProfileId: string,
  clubId: string,
): Promise<void> {
  assertClubStaff(actor, clubId);

  const [membership, demo] = await Promise.all([
    prisma.membership.findFirst({
      where: { playerProfileId, batch: { clubId } },
      select: { id: true },
    }),
    prisma.demoBooking.findFirst({
      where: { playerProfileId, clubId },
      select: { id: true },
    }),
  ]);

  if (!membership && !demo) {
    throw ApiError.forbidden('This player has no relationship with your club.');
  }
}

/** Either the account holder or club staff with a legitimate relationship. */
export async function assertCanViewPlayer(
  actor: Actor,
  playerProfileId: string,
  clubId?: string,
): Promise<void> {
  const profile = await prisma.playerProfile.findUnique({
    where: { id: playerProfileId },
    select: { accountId: true },
  });
  if (!profile) throw ApiError.notFound('Player profile');

  if (profile.accountId === actor.accountId || actor.isPlatformAdmin) return;

  if (clubId) {
    await assertCanViewPlayerAsClub(actor, playerProfileId, clubId);
    return;
  }

  throw ApiError.forbidden('You do not have access to this player.');
}

// ---------------------------------------------------------------------------
// Venue scope
// ---------------------------------------------------------------------------

export function assertVenueOwner(actor: Actor, venueId: string): void {
  if (actor.isPlatformAdmin) return;
  if (!actor.venueIds.includes(venueId)) {
    throw ApiError.forbidden('You do not own this venue.');
  }
}

export function assertPlatformAdmin(actor: Actor): void {
  if (!actor.isPlatformAdmin) {
    throw ApiError.forbidden('Platform administrators only.');
  }
}

// ---------------------------------------------------------------------------
// Chat scope
// ---------------------------------------------------------------------------

export async function assertThreadParticipant(actor: Actor, threadId: string): Promise<void> {
  const participant = await prisma.chatParticipant.findUnique({
    where: { threadId_accountId: { threadId, accountId: actor.accountId } },
    select: { id: true },
  });
  if (!participant && !actor.isPlatformAdmin) {
    throw ApiError.forbidden('You are not in this conversation.');
  }
}
