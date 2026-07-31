import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody } from '@/lib/api/handler';
import { defaultClubConfig, describeConfig, serialiseClubConfig } from '@/domain/config/engine';
import { audit, auditContextFrom } from '@/lib/audit';

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(2000).optional(),
  logoUrl: z.string().url().max(500).optional(),
  registrationNumber: z.string().max(60).optional(),
  gstin: z.string().max(20).optional(),
  contactEmail: z.string().email().max(200).optional(),
  contactPhone: z.string().max(20).optional(),
  trainingMode: z.enum(['ACADEMY', 'CREDITS', 'BOTH']).default('ACADEMY'),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** GET /api/v1/clubs — clubs this account owns or coaches at. */
export const GET = authedRoute(async ({ actor }) => {
  const clubs = await prisma.club.findMany({
    where: { id: { in: [...actor.ownedClubIds, ...actor.coachedClubIds] } },
    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      status: true,
      setupStep: true,
      trainingMode: true,
      _count: { select: { centres: true, batches: true, coaches: true } },
    },
  });

  return ok(
    clubs.map((club) => ({
      ...club,
      access: actor.ownedClubIds.includes(club.id) ? 'OWNER' : 'COACH',
    })),
  );
});

/**
 * POST /api/v1/clubs
 *
 * Step 1 of the setup wizard (spec 3.1). The club starts in DRAFT with the
 * default config and becomes discoverable only at step 10, Review & publish.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, createSchema);
  const context = auditContextFrom(request);

  const base = slugify(body.name);
  // Slugs are public URLs and must be unique; disambiguate rather than reject,
  // since two academies genuinely can share a name in different cities.
  let slug = base;
  for (let attempt = 1; await prisma.club.findUnique({ where: { slug }, select: { id: true } }); attempt += 1) {
    slug = `${base}-${attempt + 1}`;
  }

  const config = defaultClubConfig();

  const club = await prisma.$transaction(async (tx) => {
    const createdClub = await tx.club.create({
      data: {
        ownerAccountId: actor.accountId,
        name: body.name,
        slug,
        description: body.description,
        logoUrl: body.logoUrl,
        registrationNumber: body.registrationNumber,
        gstin: body.gstin,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        trainingMode: body.trainingMode,
        status: 'DRAFT',
        setupStep: 2,
        config: serialiseClubConfig(config) as Prisma.InputJsonObject,
      },
    });

    // Owning a club promotes the account's role, so the same app binary can
    // render the club dashboard (spec 1).
    await tx.account.update({
      where: { id: actor.accountId },
      data: { role: 'CLUB_OWNER' },
    });

    return createdClub;
  });

  await audit({
    action: 'club.created',
    entityType: 'Club',
    entityId: club.id,
    actorAccountId: actor.accountId,
    metadata: { name: body.name, trainingMode: body.trainingMode },
    context,
  });

  return created({
    id: club.id,
    name: club.name,
    slug: club.slug,
    status: club.status,
    setupStep: club.setupStep,
    config,
    summary: describeConfig(config),
  });
});
