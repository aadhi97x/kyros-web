import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { authedRoute } from '@/lib/api/handler';
import { assertClubOwner } from '@/lib/auth/rbac';
import { assertBuildSupported, describeConfig, parseClubConfig } from '@/domain/config/engine';
import { audit, auditContextFrom } from '@/lib/audit';

type Params = { clubId: string };

/**
 * POST /api/v1/clubs/:clubId/publish
 *
 * Step 10 of the wizard (spec 3.1): "club goes live and becomes discoverable in
 * the catalog." Refuses to publish a club that would appear in search but have
 * nothing a member could actually join — an empty listing damages the
 * marketplace more than a missing one.
 */
export const POST = authedRoute<Params>(async ({ request, params, actor }) => {
  const context = auditContextFrom(request);
  assertClubOwner(actor, params.clubId);

  const club = await prisma.club.findUniqueOrThrow({
    where: { id: params.clubId },
    include: {
      centres: { where: { isActive: true }, select: { id: true } },
      batches: { where: { isActive: true }, select: { id: true, coachId: true } },
      packages: { where: { isActive: true }, select: { id: true } },
      coaches: { where: { isActive: true }, select: { id: true } },
    },
  });

  const problems: string[] = [];
  if (club.centres.length === 0) problems.push('Add at least one centre with map coordinates.');
  if (club.coaches.length === 0) problems.push('Add at least one coach.');
  if (club.batches.length === 0) problems.push('Create at least one batch.');
  if (club.packages.length === 0) problems.push('Create at least one package.');

  const unassigned = club.batches.filter((batch) => batch.coachId === null);
  if (unassigned.length > 0) {
    problems.push(`${unassigned.length} batch(es) have no coach assigned.`);
  }

  if (problems.length > 0) {
    throw ApiError.policyViolation('This club is not ready to publish yet.', { problems });
  }

  const config = parseClubConfig(club.config);
  assertBuildSupported(config);

  const published = await prisma.club.update({
    where: { id: club.id },
    data: { status: 'PUBLISHED', publishedAt: new Date(), setupStep: 10 },
    select: { id: true, name: true, slug: true, status: true, publishedAt: true },
  });

  await audit({
    action: 'club.published',
    entityType: 'Club',
    entityId: club.id,
    actorAccountId: actor.accountId,
    context,
  });

  return ok({ ...published, summary: describeConfig(config) });
});
