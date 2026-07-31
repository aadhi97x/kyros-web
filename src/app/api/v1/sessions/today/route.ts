import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { authedRoute } from '@/lib/api/handler';

/**
 * GET /api/v1/sessions/today
 *
 * Spec 4.1: the coach's landing screen — today's batches and timings at a
 * glance. Returns the full roster with each session so the app can cache
 * everything it needs to mark attendance with no connectivity at all.
 */
export const GET = authedRoute(async ({ actor }) => {
  if (actor.coachIds.length === 0 && actor.ownedClubIds.length === 0) {
    throw ApiError.forbidden('This account is not a coach or club owner.');
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const sessions = await prisma.session.findMany({
    where: {
      startsAt: { gte: dayStart, lt: dayEnd },
      status: { not: 'CANCELLED' },
      OR: [
        { coachId: { in: actor.coachIds } },
        { batch: { coachId: { in: actor.coachIds } } },
        { batch: { clubId: { in: actor.ownedClubIds } } },
      ],
    },
    orderBy: { startsAt: 'asc' },
    include: {
      batch: {
        select: {
          id: true,
          name: true,
          mode: true,
          club: { select: { id: true, name: true, config: true } },
        },
      },
      centre: {
        select: {
          id: true,
          name: true,
          address: true,
          latitude: true,
          longitude: true,
          geofenceRadiusM: true,
        },
      },
      attendances: {
        select: { playerProfileId: true, status: true, markedAt: true, recordedAtDevice: true },
      },
    },
  });

  // Roster per batch, fetched once for all of today's sessions.
  const batchIds = [...new Set(sessions.map((session) => session.batchId))];
  const memberships = await prisma.membership.findMany({
    where: { batchId: { in: batchIds }, status: { in: ['ACTIVE', 'PAUSED'] } },
    select: {
      batchId: true,
      status: true,
      playerProfile: {
        select: { id: true, fullName: true, photoUrl: true, positions: true, medicalNotes: true },
      },
    },
  });

  const rosterByBatch = new Map<string, typeof memberships>();
  for (const membership of memberships) {
    const list = rosterByBatch.get(membership.batchId) ?? [];
    list.push(membership);
    rosterByBatch.set(membership.batchId, list);
  }

  return ok(
    sessions.map((session) => {
      const marked = new Map(session.attendances.map((row) => [row.playerProfileId, row]));
      const roster = rosterByBatch.get(session.batchId) ?? [];

      return {
        id: session.id,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        status: session.status,
        syllabusModule: session.syllabusModule,
        notes: session.notes,
        batch: { id: session.batch.id, name: session.batch.name, mode: session.batch.mode },
        club: { id: session.batch.club.id, name: session.batch.club.name },
        centre: session.centre,
        attendanceComplete: roster.length > 0 && marked.size >= roster.length,
        roster: roster.map((membership) => ({
          playerProfileId: membership.playerProfile.id,
          fullName: membership.playerProfile.fullName,
          photoUrl: membership.playerProfile.photoUrl,
          positions: membership.playerProfile.positions,
          // Coaches need this on the pitch; it is consented under
          // MEDICAL_EMERGENCY and shown only to the club's own staff.
          medicalNotes: membership.playerProfile.medicalNotes,
          membershipStatus: membership.status,
          currentMark: marked.get(membership.playerProfile.id)?.status ?? null,
        })),
      };
    }),
  );
});
