/**
 * Discovery catalog.
 *
 * Spec 2.4: "Every filter maps to a field already stored on the batch, package
 * or centre — no separate metadata layer." So this module builds a Prisma
 * `where` from the filter input and nothing else; there is no denormalised
 * search index to drift out of step with the real data.
 *
 * Spec 0.5: "Discovery is uniform, enrollment is configured." Every club is
 * searched identically. The club's config only starts mattering once the member
 * taps join, which is the state machine's problem, not this module's.
 */

import { z } from 'zod';
import { prisma, type Prisma } from '@/lib/db';
import { parseClubConfigSafe, primaryCallToAction, toMemberFacingConfig } from '../config/engine';

const csv = (value: unknown) =>
  typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : undefined;

export const catalogFilterSchema = z.object({
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  /** Distance search — all three required together. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).default(25).optional(),

  mode: z.preprocess(csv, z.array(z.enum(['ACADEMY', 'CREDITS'])).optional()),
  batchType: z.preprocess(csv, z.array(z.enum(['GENERAL', 'SQUAD', 'ELITE'])).optional()),
  skillLevel: z.preprocess(
    csv,
    z.array(z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ELITE'])).optional(),
  ),

  /** The player's age — matched against the batch's band. */
  age: z.coerce.number().int().min(3).max(80).optional(),
  minAge: z.coerce.number().int().min(3).max(80).optional(),
  maxAge: z.coerce.number().int().min(3).max(80).optional(),

  minPricePaise: z.coerce.number().int().min(0).optional(),
  maxPricePaise: z.coerce.number().int().min(0).optional(),

  /** 0 = Sunday. A batch matches if ANY of its sessions fall on these days. */
  days: z.preprocess(csv, z.array(z.coerce.number().int().min(0).max(6)).optional()),
  /** Minutes from midnight — matches batches whose sessions start in range. */
  startAfterMinute: z.coerce.number().int().min(0).max(1439).optional(),
  startBeforeMinute: z.coerce.number().int().min(0).max(1439).optional(),

  positions: z.preprocess(csv, z.array(z.string().max(40)).optional()),
  amenities: z.preprocess(csv, z.array(z.string().max(40)).optional()),

  hasSpace: z.coerce.boolean().optional(),
  sort: z.enum(['RELEVANCE', 'PRICE_ASC', 'PRICE_DESC', 'RATING', 'DISTANCE']).default('RELEVANCE'),
});

export type CatalogFilters = z.infer<typeof catalogFilterSchema>;

export interface CatalogCard {
  batchId: string;
  batchName: string;
  clubId: string;
  clubName: string;
  clubLogoUrl: string | null;
  centreId: string;
  centreName: string;
  city: string;
  latitude: number;
  longitude: number;
  distanceKm: number | null;
  mode: 'ACADEMY' | 'CREDITS';
  batchType: string;
  skillLevel: string;
  minAge: number;
  maxAge: number;
  capacity: number;
  spotsLeft: number;
  hasSpace: boolean;
  fromPricePaise: number | null;
  billingType: string | null;
  rating: number;
  ratingCount: number;
  schedule: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
  amenities: string[];
  /** Spec 2.5 — what the primary button should say for this club. */
  callToAction: 'BOOK_DEMO' | 'START_TRIAL' | 'ENROLL';
}

/** Degrees of latitude per kilometre — used to pre-filter before exact maths. */
const KM_PER_DEGREE_LAT = 111.32;

function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  // Longitude degrees shrink towards the poles.
  const lngDelta = radiusKm / (KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180) || 1);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude));
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function buildCatalogWhere(filters: CatalogFilters): Prisma.BatchWhereInput {
  const where: Prisma.BatchWhereInput = {
    isActive: true,
    // Only PUBLISHED clubs are discoverable. A draft club must never leak.
    club: { status: 'PUBLISHED' },
  };

  const clubFilter: Prisma.ClubWhereInput = { status: 'PUBLISHED' };
  const centreFilter: Prisma.CentreWhereInput = { isActive: true };

  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: 'insensitive' } },
      { club: { name: { contains: filters.q, mode: 'insensitive' }, status: 'PUBLISHED' } },
      { centre: { name: { contains: filters.q, mode: 'insensitive' } } },
      { centre: { city: { contains: filters.q, mode: 'insensitive' } } },
    ];
  }

  if (filters.city) centreFilter.city = { equals: filters.city, mode: 'insensitive' };

  if (filters.lat !== undefined && filters.lng !== undefined) {
    // Bounding box only — the exact circle is applied after fetching, because
    // a real distance filter needs PostGIS and this is fast enough at the
    // catalog's size.
    const box = boundingBox(filters.lat, filters.lng, filters.radiusKm ?? 25);
    centreFilter.latitude = { gte: box.minLat, lte: box.maxLat };
    centreFilter.longitude = { gte: box.minLng, lte: box.maxLng };
  }

  if (filters.amenities?.length) centreFilter.amenities = { hasSome: filters.amenities };

  if (filters.mode?.length) where.mode = { in: filters.mode };
  if (filters.batchType?.length) where.type = { in: filters.batchType };
  if (filters.skillLevel?.length) where.skillLevel = { in: filters.skillLevel };

  // A single age matches any band that contains it; an explicit min/max
  // narrows to bands overlapping the requested range.
  if (filters.age !== undefined) {
    where.minAge = { lte: filters.age };
    where.maxAge = { gte: filters.age };
  } else {
    if (filters.minAge !== undefined) where.maxAge = { gte: filters.minAge };
    if (filters.maxAge !== undefined) where.minAge = { lte: filters.maxAge };
  }

  if (filters.days?.length || filters.startAfterMinute !== undefined || filters.startBeforeMinute !== undefined) {
    const scheduleFilter: Prisma.BatchScheduleWhereInput = {};
    if (filters.days?.length) scheduleFilter.dayOfWeek = { in: filters.days };
    if (filters.startAfterMinute !== undefined) {
      scheduleFilter.startMinute = { gte: filters.startAfterMinute };
    }
    if (filters.startBeforeMinute !== undefined) {
      scheduleFilter.startMinute = {
        ...(scheduleFilter.startMinute as object),
        lte: filters.startBeforeMinute,
      };
    }
    where.schedule = { some: scheduleFilter };
  }

  if (filters.minPricePaise !== undefined || filters.maxPricePaise !== undefined) {
    const priceFilter: Prisma.PackageWhereInput = { isActive: true };
    if (filters.minPricePaise !== undefined) priceFilter.pricePaise = { gte: filters.minPricePaise };
    if (filters.maxPricePaise !== undefined) {
      priceFilter.pricePaise = { ...(priceFilter.pricePaise as object), lte: filters.maxPricePaise };
    }
    where.packages = { some: priceFilter };
  }

  where.club = clubFilter;
  where.centre = centreFilter;

  return where;
}

export async function searchCatalog(
  filters: CatalogFilters,
  pagination: { page: number; perPage: number },
): Promise<{ cards: CatalogCard[]; total: number }> {
  const where = buildCatalogWhere(filters);

  const orderBy: Prisma.BatchOrderByWithRelationInput[] =
    filters.sort === 'RATING'
      ? [{ club: { ratingAverage: 'desc' } }]
      : [{ createdAt: 'desc' }];

  const [rows, total] = await Promise.all([
    prisma.batch.findMany({
      where,
      orderBy,
      skip: (pagination.page - 1) * pagination.perPage,
      take: pagination.perPage,
      include: {
        club: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            config: true,
            ratingAverage: true,
            ratingCount: true,
          },
        },
        centre: {
          select: { id: true, name: true, city: true, latitude: true, longitude: true, amenities: true },
        },
        schedule: { select: { dayOfWeek: true, startMinute: true, endMinute: true } },
        packages: {
          where: { isActive: true },
          orderBy: { pricePaise: 'asc' },
          take: 1,
          select: { pricePaise: true, billingType: true },
        },
      },
    }),
    prisma.batch.count({ where }),
  ]);

  const origin =
    filters.lat !== undefined && filters.lng !== undefined
      ? { latitude: filters.lat, longitude: filters.lng }
      : null;

  let cards: CatalogCard[] = rows.map((batch) => {
    // parseClubConfigSafe, not parseClubConfig: one club with a broken config
    // must not take down the whole catalog.
    const { config } = parseClubConfigSafe(batch.club.config);
    const cheapest = batch.packages[0] ?? null;
    const spotsLeft = Math.max(0, batch.capacity - batch.activeCount);

    return {
      batchId: batch.id,
      batchName: batch.name,
      clubId: batch.club.id,
      clubName: batch.club.name,
      clubLogoUrl: batch.club.logoUrl,
      centreId: batch.centre.id,
      centreName: batch.centre.name,
      city: batch.centre.city,
      latitude: batch.centre.latitude,
      longitude: batch.centre.longitude,
      distanceKm: origin ? Number(distanceKm(origin, batch.centre).toFixed(1)) : null,
      mode: batch.mode,
      batchType: batch.type,
      skillLevel: batch.skillLevel,
      minAge: batch.minAge,
      maxAge: batch.maxAge,
      capacity: batch.capacity,
      spotsLeft,
      hasSpace: spotsLeft > 0,
      fromPricePaise: cheapest?.pricePaise ?? null,
      billingType: cheapest?.billingType ?? null,
      rating: batch.club.ratingAverage,
      ratingCount: batch.club.ratingCount,
      schedule: batch.schedule,
      amenities: batch.centre.amenities,
      callToAction: primaryCallToAction(config),
    };
  });

  // Exact radius, applied after the bounding-box prefilter.
  if (origin && filters.radiusKm) {
    cards = cards.filter((card) => card.distanceKm !== null && card.distanceKm <= filters.radiusKm!);
  }

  if (filters.hasSpace) cards = cards.filter((card) => card.hasSpace);

  switch (filters.sort) {
    case 'PRICE_ASC':
      cards.sort((a, b) => (a.fromPricePaise ?? Infinity) - (b.fromPricePaise ?? Infinity));
      break;
    case 'PRICE_DESC':
      cards.sort((a, b) => (b.fromPricePaise ?? -1) - (a.fromPricePaise ?? -1));
      break;
    case 'DISTANCE':
      cards.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      break;
    case 'RATING':
      cards.sort((a, b) => b.rating - a.rating);
      break;
    case 'RELEVANCE':
      break;
  }

  return { cards, total };
}

/** Club detail (spec 2.5) — public, so it exposes only the member-facing config. */
export async function clubDetail(clubId: string) {
  const club = await prisma.club.findFirst({
    where: { id: clubId, status: 'PUBLISHED' },
    include: {
      centres: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          latitude: true,
          longitude: true,
          amenities: true,
        },
      },
      batches: {
        where: { isActive: true },
        include: {
          schedule: true,
          coach: { select: { id: true, name: true, photoUrl: true, qualification: true } },
          centre: { select: { id: true, name: true } },
          packages: {
            where: { isActive: true },
            include: { addOns: true },
            orderBy: { pricePaise: 'asc' },
          },
        },
      },
    },
  });

  if (!club) return null;

  const { config } = parseClubConfigSafe(club.config);

  return {
    id: club.id,
    name: club.name,
    slug: club.slug,
    logoUrl: club.logoUrl,
    description: club.description,
    contactEmail: club.contactEmail,
    contactPhone: club.contactPhone,
    rating: club.ratingAverage,
    ratingCount: club.ratingCount,
    trainingMode: club.trainingMode,
    centres: club.centres,
    batches: club.batches.map((batch) => ({
      ...batch,
      spotsLeft: Math.max(0, batch.capacity - batch.activeCount),
    })),
    // Never the raw config — members have no business seeing absentee
    // thresholds or geofence enforcement settings.
    config: toMemberFacingConfig(config),
    callToAction: primaryCallToAction(config),
  };
}
