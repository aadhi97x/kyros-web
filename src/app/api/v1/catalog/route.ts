import { buildPageMeta, paginated } from '@/lib/api/response';
import { optionalAuthRoute, parsePagination, parseQuery } from '@/lib/api/handler';
import { catalogFilterSchema, searchCatalog } from '@/domain/catalog/search';

/**
 * GET /api/v1/catalog
 *
 * Spec 2.4: the marketplace front door. Public — a member browses before
 * signing up. Every listed club is searched the same way; the club's own
 * configuration only starts mattering at the point of joining.
 *
 * Filters: q, city, lat/lng/radiusKm, mode, batchType, skillLevel, age,
 * minAge/maxAge, minPricePaise/maxPricePaise, days, startAfterMinute,
 * startBeforeMinute, amenities, hasSpace, sort.
 */
export const GET = optionalAuthRoute(async ({ request }) => {
  const filters = parseQuery(request, catalogFilterSchema);
  const pagination = parsePagination(request, 50);

  const { cards, total } = await searchCatalog(filters, pagination);

  return paginated(cards, buildPageMeta(pagination.page, pagination.perPage, total));
});
