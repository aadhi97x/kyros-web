/**
 * Uniform API envelopes.
 *
 * Success: { data, meta? }
 * Failure: { error: { code, message, details? } }
 *
 * The mobile client's fetch wrapper depends on exactly this shape.
 */

import { NextResponse } from 'next/server';
import { ApiError, type ApiErrorCode } from './errors';

export interface PageMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  return NextResponse.json(meta ? { data, meta } : { data }, { status });
}

export function created<T>(data: T) {
  return ok(data, undefined, 201);
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function paginated<T>(items: T[], meta: PageMeta) {
  return NextResponse.json({ data: items, meta }, { status: 200 });
}

export function fail(code: ApiErrorCode, message: string, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: new ApiError(code, message).status },
  );
}

export function failFromError(error: ApiError) {
  return fail(error.code, error.message, error.details);
}

export function buildPageMeta(page: number, perPage: number, total: number): PageMeta {
  const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;
  return {
    page,
    perPage,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}
