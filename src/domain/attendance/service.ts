/**
 * Attendance — including the offline sync path.
 *
 * Spec 4.3: "Must work offline and sync when connectivity returns — Indian
 * ground conditions demand this."
 *
 * The contract with the mobile client:
 *   - The coach's device generates a `clientMutationId` (a UUID) per mark and
 *     queues it locally.
 *   - On reconnect the whole queue is POSTed as a batch.
 *   - The server treats `clientMutationId` as the idempotency key. Replaying a
 *     batch — which WILL happen, because the response to the first attempt is
 *     exactly what gets lost on a bad connection — changes nothing.
 *   - Each item carries `recordedAtDevice`, so a mark made at 4pm and synced at
 *     9pm is recorded as having happened at 4pm.
 *
 * Conflict rule: last write by device time wins. If two coaches marked the same
 * player, the later device timestamp is authoritative; ties resolve to the
 * record already stored, so a replay never flip-flops.
 */

import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { audit, type AuditContext } from '@/lib/audit';
import { parseClubConfig } from '../config/engine';

export type AttendanceMark = 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';

export interface AttendanceEntry {
  playerProfileId: string;
  status: AttendanceMark;
  /** When the coach actually tapped, per the device clock. */
  recordedAtDevice: string;
  /** Client-generated UUID. The idempotency key for this mark. */
  clientMutationId: string;
  checkInTime?: string;
}

export interface SyncAttendanceInput {
  sessionId: string;
  coachId: string;
  entries: AttendanceEntry[];
  context?: AuditContext;
}

export interface SyncAttendanceResult {
  applied: number;
  duplicates: number;
  superseded: number;
  rejected: Array<{ clientMutationId: string; reason: string }>;
  /** Echoed so the client knows exactly which queue items to drop. */
  acknowledgedMutationIds: string[];
}

/**
 * Apply a batch of attendance marks.
 *
 * Every entry is processed independently: one bad row (a player who left the
 * batch, say) must not reject the other twenty-nine, or the coach's queue can
 * never drain.
 */
export async function syncAttendance(input: SyncAttendanceInput): Promise<SyncAttendanceResult> {
  const session = await prisma.session.findUnique({
    where: { id: input.sessionId },
    select: {
      id: true,
      startsAt: true,
      status: true,
      batchId: true,
      batch: { select: { clubId: true, club: { select: { config: true } } } },
    },
  });

  if (!session) throw ApiError.notFound('Session');

  const config = parseClubConfig(session.batch.club.config);

  // Roster check: who is actually entitled to be marked in this session.
  const enrolled = await prisma.membership.findMany({
    where: { batchId: session.batchId, status: { in: ['ACTIVE', 'PAUSED'] } },
    select: { playerProfileId: true },
  });
  const roster = new Set(enrolled.map((membership) => membership.playerProfileId));

  const result: SyncAttendanceResult = {
    applied: 0,
    duplicates: 0,
    superseded: 0,
    rejected: [],
    acknowledgedMutationIds: [],
  };

  for (const entry of input.entries) {
    try {
      const outcome = await applyEntry({ session, config, entry, coachId: input.coachId, roster });

      if (outcome === 'DUPLICATE') result.duplicates += 1;
      else if (outcome === 'SUPERSEDED') result.superseded += 1;
      else result.applied += 1;

      // Acknowledged either way — a duplicate is still safely stored, and the
      // client must drop it from the queue rather than retrying forever.
      result.acknowledgedMutationIds.push(entry.clientMutationId);
    } catch (error) {
      const reason = error instanceof ApiError ? error.message : 'Could not record this mark.';
      result.rejected.push({ clientMutationId: entry.clientMutationId, reason });
      // Rejections are acknowledged too. A mark for a player who has left the
      // batch will never succeed, and leaving it queued would block the device
      // forever.
      result.acknowledgedMutationIds.push(entry.clientMutationId);
    }
  }

  await audit({
    action: 'attendance.marked',
    entityType: 'Session',
    entityId: input.sessionId,
    metadata: {
      coachId: input.coachId,
      applied: result.applied,
      duplicates: result.duplicates,
      superseded: result.superseded,
      rejected: result.rejected.length,
    },
    context: input.context,
  });

  return result;
}

type EntryOutcome = 'APPLIED' | 'DUPLICATE' | 'SUPERSEDED';

async function applyEntry(params: {
  session: { id: string; startsAt: Date; batchId: string };
  config: ReturnType<typeof parseClubConfig>;
  entry: AttendanceEntry;
  coachId: string;
  roster: Set<string>;
}): Promise<EntryOutcome> {
  const { session, config, entry, coachId, roster } = params;

  if (!roster.has(entry.playerProfileId)) {
    throw ApiError.badRequest('That player is not on this session’s roster.');
  }

  const recordedAtDevice = new Date(entry.recordedAtDevice);
  if (Number.isNaN(recordedAtDevice.getTime())) {
    throw ApiError.badRequest('recordedAtDevice is not a valid timestamp.');
  }

  // A device clock can be wrong, sometimes wildly. Clamp anything in the future
  // to now rather than rejecting it — the coach did mark it, and losing real
  // attendance data over a bad clock is the worse failure.
  const effectiveDeviceTime = recordedAtDevice.getTime() > Date.now() ? new Date() : recordedAtDevice;

  // Auto-upgrade PRESENT to LATE past the club's threshold, so the coach does
  // not have to watch the clock while marking a roster of thirty.
  let status: AttendanceMark = entry.status;
  if (status === 'PRESENT' && config.attendance.lateThresholdMinutes > 0) {
    const minutesAfterStart = (effectiveDeviceTime.getTime() - session.startsAt.getTime()) / 60_000;
    if (minutesAfterStart > config.attendance.lateThresholdMinutes) {
      status = 'LATE';
    }
  }

  // Exact replay of a mutation we already stored.
  const byMutationId = await prisma.attendance.findUnique({
    where: { clientMutationId: entry.clientMutationId },
    select: { id: true },
  });
  if (byMutationId) return 'DUPLICATE';

  const existing = await prisma.attendance.findUnique({
    where: {
      sessionId_playerProfileId: {
        sessionId: session.id,
        playerProfileId: entry.playerProfileId,
      },
    },
    select: { id: true, recordedAtDevice: true, markedAt: true, status: true },
  });

  if (!existing) {
    await prisma.attendance.create({
      data: {
        sessionId: session.id,
        playerProfileId: entry.playerProfileId,
        status,
        source: 'COACH_TAP',
        checkInTime: entry.checkInTime ? new Date(entry.checkInTime) : effectiveDeviceTime,
        markedByCoachId: coachId,
        clientMutationId: entry.clientMutationId,
        recordedAtDevice: effectiveDeviceTime,
        syncedAt: new Date(),
      },
    });
    return 'APPLIED';
  }

  // Last-write-wins by DEVICE time, not arrival time. Two coaches marking the
  // same player from different devices should resolve by when each actually
  // tapped, not by whose connection recovered first.
  const existingTime = existing.recordedAtDevice ?? existing.markedAt;
  if (effectiveDeviceTime.getTime() <= existingTime.getTime()) {
    return 'SUPERSEDED';
  }

  await prisma.attendance.update({
    where: { id: existing.id },
    data: {
      status,
      source: 'OFFLINE_SYNC',
      checkInTime: entry.checkInTime ? new Date(entry.checkInTime) : effectiveDeviceTime,
      markedByCoachId: coachId,
      clientMutationId: entry.clientMutationId,
      recordedAtDevice: effectiveDeviceTime,
      markedAt: new Date(),
      syncedAt: new Date(),
    },
  });

  return 'APPLIED';
}

// ---------------------------------------------------------------------------
// Absentee follow-up (spec 3.7)
// ---------------------------------------------------------------------------

export interface AbsenteeRow {
  playerProfileId: string;
  playerName: string;
  accountId: string;
  accountName: string;
  accountPhone: string;
  batchId: string;
  batchName: string;
  missedCount: number;
  lastAttendedAt: Date | null;
}

/**
 * "Auto-generated list of members who have missed a defined number of sessions,
 * with a one-tap message action." The threshold and window come from the club's
 * config, not from a constant here.
 */
export async function absenteeFollowUpList(clubId: string): Promise<AbsenteeRow[]> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { config: true },
  });
  if (!club) throw ApiError.notFound('Club');

  const config = parseClubConfig(club.config);
  const { absenteeFollowUpAfterMisses, absenteeLookbackDays } = config.attendance;

  const since = new Date();
  since.setDate(since.getDate() - absenteeLookbackDays);

  const absences = await prisma.attendance.groupBy({
    by: ['playerProfileId'],
    where: {
      status: 'ABSENT',
      markedAt: { gte: since },
      session: { batch: { clubId } },
    },
    _count: { _all: true },
    having: { playerProfileId: { _count: { gte: absenteeFollowUpAfterMisses } } },
  });

  if (absences.length === 0) return [];

  const playerIds = absences.map((row) => row.playerProfileId);
  const missedByPlayer = new Map(absences.map((row) => [row.playerProfileId, row._count._all]));

  const memberships = await prisma.membership.findMany({
    where: { playerProfileId: { in: playerIds }, status: 'ACTIVE', batch: { clubId } },
    select: {
      batchId: true,
      batch: { select: { name: true } },
      playerProfile: {
        select: {
          id: true,
          fullName: true,
          account: { select: { id: true, name: true, phone: true } },
        },
      },
    },
  });

  const lastAttendances = await prisma.attendance.groupBy({
    by: ['playerProfileId'],
    where: { playerProfileId: { in: playerIds }, status: { in: ['PRESENT', 'LATE'] } },
    _max: { markedAt: true },
  });
  const lastByPlayer = new Map(
    lastAttendances.map((row) => [row.playerProfileId, row._max.markedAt]),
  );

  return memberships
    .map((membership) => ({
      playerProfileId: membership.playerProfile.id,
      playerName: membership.playerProfile.fullName,
      accountId: membership.playerProfile.account.id,
      accountName: membership.playerProfile.account.name,
      accountPhone: membership.playerProfile.account.phone,
      batchId: membership.batchId,
      batchName: membership.batch.name,
      missedCount: missedByPlayer.get(membership.playerProfile.id) ?? 0,
      lastAttendedAt: lastByPlayer.get(membership.playerProfile.id) ?? null,
    }))
    .sort((a, b) => b.missedCount - a.missedCount);
}

// ---------------------------------------------------------------------------
// Geofenced coach check-in (spec 4.2)
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. Accurate enough at geofence scale. */
export function haversineMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function recordCoachCheckIn(params: {
  coachId: string;
  sessionId?: string;
  centreId: string;
  latitude: number;
  longitude: number;
  accuracyM?: number;
  context?: AuditContext;
}): Promise<{ accepted: boolean; distanceM: number; flagged: boolean; minutesLate: number | null }> {
  const centre = await prisma.centre.findUnique({
    where: { id: params.centreId },
    select: { id: true, latitude: true, longitude: true, geofenceRadiusM: true, club: { select: { config: true } } },
  });
  if (!centre) throw ApiError.notFound('Centre');

  const config = parseClubConfig(centre.club.config);
  const distanceM = haversineMetres(centre, params);

  // A phone reporting ±50m accuracy standing on the touchline should not be
  // rejected for being 30m out, so the reported accuracy widens the fence.
  const effectiveRadius = centre.geofenceRadiusM + Math.min(params.accuracyM ?? 0, 100);
  const withinGeofence = distanceM <= effectiveRadius;

  const enforcement = config.attendance.geofenceEnforcement;
  if (!withinGeofence && enforcement === 'REJECT') {
    throw ApiError.policyViolation(
      `Check-in must happen at the centre. You are ${Math.round(distanceM)}m away.`,
      { distanceM: Math.round(distanceM), radiusM: centre.geofenceRadiusM },
    );
  }

  let minutesLate: number | null = null;
  if (params.sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: params.sessionId },
      select: { startsAt: true },
    });
    if (session) {
      minutesLate = Math.max(0, Math.round((Date.now() - session.startsAt.getTime()) / 60_000));
    }
  }

  await prisma.coachCheckIn.create({
    data: {
      coachId: params.coachId,
      sessionId: params.sessionId,
      latitude: params.latitude,
      longitude: params.longitude,
      accuracyM: params.accuracyM,
      distanceFromCentreM: distanceM,
      withinGeofence,
      flaggedForReview: !withinGeofence && enforcement === 'FLAG_FOR_REVIEW',
      minutesLate,
    },
  });

  await audit({
    action: 'coach.checked_in',
    entityType: 'Coach',
    entityId: params.coachId,
    metadata: {
      sessionId: params.sessionId,
      distanceM: Math.round(distanceM),
      withinGeofence,
      minutesLate,
    },
    context: params.context,
  });

  return {
    accepted: true,
    distanceM: Math.round(distanceM),
    flagged: !withinGeofence && enforcement === 'FLAG_FOR_REVIEW',
    minutesLate,
  };
}
