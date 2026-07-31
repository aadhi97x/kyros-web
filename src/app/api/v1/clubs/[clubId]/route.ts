import { ApiError } from '@/lib/api/errors';
import { ok } from '@/lib/api/response';
import { optionalAuthRoute } from '@/lib/api/handler';
import { clubDetail } from '@/domain/catalog/search';

type Params = { clubId: string };

/**
 * GET /api/v1/clubs/:clubId
 *
 * Spec 2.5: club detail — photos, description, centres with map locations,
 * rating, contact, batches and packages, plus the member-facing slice of the
 * club's config so the app knows what its primary button should say.
 */
export const GET = optionalAuthRoute<Params>(async ({ params }) => {
  const club = await clubDetail(params.clubId);
  if (!club) throw ApiError.notFound('Club');
  return ok(club);
});
