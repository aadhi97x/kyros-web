/**
 * Route handler wrapper.
 *
 * Every API route goes through `route()`. It gives us one place for error
 * translation, so a Zod failure, a Prisma unique-constraint violation and a
 * domain policy refusal all reach the client in the same envelope with a
 * useful code — instead of each handler inventing its own.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from './errors';
import { fail } from './response';
import { ClubConfigError } from '@/domain/config/engine';
import { EnrollmentTransitionError } from '@/domain/enrollment/state-machine';
import { VerificationError } from '@/domain/consent/verification';
import { authenticate, authenticateOptional, type Actor } from '@/lib/auth/session';

export interface RouteContext<P = Record<string, string>> {
  request: NextRequest;
  params: P;
}

export interface AuthedRouteContext<P = Record<string, string>> extends RouteContext<P> {
  actor: Actor;
}

type Handler<P> = (context: RouteContext<P>) => Promise<NextResponse> | NextResponse;
type AuthedHandler<P> = (context: AuthedRouteContext<P>) => Promise<NextResponse> | NextResponse;

/** Next 15 passes params as a promise. */
type NextRouteArgs<P> = { params: Promise<P> };

function translate(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return fail(error.code, error.message, error.details);
  }

  if (error instanceof ZodError) {
    return fail('VALIDATION_FAILED', 'Some of the values sent were not valid.', {
      fields: Object.fromEntries(
        error.issues.map((issue) => [issue.path.join('.') || '_', issue.message]),
      ),
    });
  }

  if (error instanceof ClubConfigError) {
    return fail('CONFIG_INVALID', error.message, { fields: error.toFieldErrors() });
  }

  if (error instanceof EnrollmentTransitionError) {
    return fail('ENROLLMENT_STEP_INVALID', error.message, {
      step: error.decision.step,
      allowed: error.decision.availableActions,
    });
  }

  if (error instanceof VerificationError) {
    return fail('CONSENT_REQUIRED', error.message, { method: error.method });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 unique constraint — the useful case is telling the client WHICH
    // field collided, so a signup form can point at the right input.
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target : [String(target ?? 'value')];
      return fail('CONFLICT', `That ${fields.join(' and ')} is already in use.`, { fields });
    }
    if (error.code === 'P2025') {
      return fail('NOT_FOUND', 'That record no longer exists.');
    }
    if (error.code === 'P2003') {
      return fail('BAD_REQUEST', 'That references something which does not exist.');
    }
  }

  // Unknown: log the detail server-side, tell the client nothing useful to an
  // attacker.
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', error);
  return fail('INTERNAL', 'Something went wrong on our end.');
}

/** Public route — no authentication required. */
export function route<P = Record<string, string>>(handler: Handler<P>) {
  return async (request: NextRequest, args?: NextRouteArgs<P>): Promise<NextResponse> => {
    try {
      const params = ((await args?.params) ?? {}) as P;
      return await handler({ request, params });
    } catch (error) {
      return translate(error);
    }
  };
}

/** Authenticated route — 401s before the handler runs. */
export function authedRoute<P = Record<string, string>>(handler: AuthedHandler<P>) {
  return async (request: NextRequest, args?: NextRouteArgs<P>): Promise<NextResponse> => {
    try {
      const params = ((await args?.params) ?? {}) as P;
      const actor = await authenticate(request);
      return await handler({ request, params, actor });
    } catch (error) {
      return translate(error);
    }
  };
}

/** Route that behaves differently signed in vs anonymous (e.g. the catalog). */
export function optionalAuthRoute<P = Record<string, string>>(
  handler: (context: RouteContext<P> & { actor: Actor | null }) => Promise<NextResponse> | NextResponse,
) {
  return async (request: NextRequest, args?: NextRouteArgs<P>): Promise<NextResponse> => {
    try {
      const params = ((await args?.params) ?? {}) as P;
      const actor = await authenticateOptional(request);
      return await handler({ request, params, actor });
    } catch (error) {
      return translate(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/**
 * Generic over the SCHEMA rather than over a value type, so `z.infer` gives the
 * parsed OUTPUT. Writing `schema: ZodSchema<T>` instead makes TypeScript infer
 * T from the input side, which silently hands callers optional fields for every
 * `.default()` in the schema.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: NextRequest,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest('Expected a JSON body.');
  }
  return schema.parse(raw) as z.infer<S>;
}

export function parseQuery<S extends ZodTypeAny>(request: NextRequest, schema: S): z.infer<S> {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  return schema.parse(params) as z.infer<S>;
}

export interface PaginationInput {
  page: number;
  perPage: number;
}

export function parsePagination(request: NextRequest, maxPerPage = 100): PaginationInput {
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? 1) || 1);
  const requested = Number(request.nextUrl.searchParams.get('perPage') ?? 20) || 20;
  const perPage = Math.min(maxPerPage, Math.max(1, requested));
  return { page, perPage };
}
