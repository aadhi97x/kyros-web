import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { assertClubOwner } from '@/lib/auth/rbac';
import {
  applyConfigPatch,
  assertBuildSupported,
  describeConfig,
  parseClubConfig,
  serialiseClubConfig,
} from '@/domain/config/engine';
import { audit, auditContextFrom } from '@/lib/audit';

type Params = { clubId: string };

/**
 * GET /api/v1/clubs/:clubId/config
 *
 * The owner's full config — every toggle from spec 3.2, plus a plain-language
 * summary for the wizard's review step.
 */
export const GET = authedRoute<Params>(async ({ params, actor }) => {
  assertClubOwner(actor, params.clubId);

  const club = await prisma.club.findUniqueOrThrow({
    where: { id: params.clubId },
    select: { config: true, setupStep: true, status: true },
  });

  const config = parseClubConfig(club.config);

  return ok({
    config,
    setupStep: club.setupStep,
    status: club.status,
    summary: describeConfig(config),
  });
});

/**
 * PATCH /api/v1/clubs/:clubId/config
 *
 * Accepts a partial update from one wizard step. The whole object is
 * re-validated — a change here can invalidate a combination set three steps
 * earlier, and the owner needs to hear about it now rather than when a member
 * hits a dead end.
 */
export const PATCH = authedRoute<Params>(async ({ request, params, actor }) => {
  // Deliberately unvalidated at this layer: the config engine owns the schema,
  // and duplicating it here would guarantee the two drift apart.
  const patch = await parseBody(request, z.record(z.unknown()));
  const context = auditContextFrom(request);

  assertClubOwner(actor, params.clubId);

  const club = await prisma.club.findUniqueOrThrow({
    where: { id: params.clubId },
    select: { config: true },
  });

  const current = parseClubConfig(club.config);
  const next = applyConfigPatch(current, patch);
  assertBuildSupported(next);

  await prisma.club.update({
    where: { id: params.clubId },
    data: { config: serialiseClubConfig(next) as Prisma.InputJsonObject },
  });

  await audit({
    action: 'club.config_updated',
    entityType: 'Club',
    entityId: params.clubId,
    actorAccountId: actor.accountId,
    metadata: { changedSections: Object.keys(patch) },
    context,
  });

  return ok({ config: next, summary: describeConfig(next) });
});
