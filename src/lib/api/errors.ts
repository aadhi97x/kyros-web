/**
 * The API's error vocabulary.
 *
 * Every failure the client can act on gets a stable machine-readable `code`.
 * The mobile app branches on codes, never on message text.
 */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_ATTEMPTS_EXCEEDED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_WITHDRAWN'
  | 'ENROLLMENT_STEP_INVALID'
  | 'BATCH_AT_CAPACITY'
  | 'WAITLIST_FULL'
  | 'PAYMENT_FAILED'
  | 'POLICY_VIOLATION'
  | 'SLOT_UNAVAILABLE'
  | 'CONFIG_INVALID'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  OTP_INVALID: 400,
  OTP_EXPIRED: 410,
  OTP_ATTEMPTS_EXCEEDED: 429,
  CONSENT_REQUIRED: 451,
  CONSENT_WITHDRAWN: 451,
  ENROLLMENT_STEP_INVALID: 409,
  BATCH_AT_CAPACITY: 409,
  WAITLIST_FULL: 409,
  PAYMENT_FAILED: 402,
  POLICY_VIOLATION: 422,
  SLOT_UNAVAILABLE: 409,
  CONFIG_INVALID: 422,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError('BAD_REQUEST', message, details);
  }
  static unauthenticated(message = 'Sign in to continue.') {
    return new ApiError('UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have access to this resource.') {
    return new ApiError('FORBIDDEN', message);
  }
  static notFound(what = 'Resource') {
    return new ApiError('NOT_FOUND', `${what} not found.`);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError('CONFLICT', message, details);
  }
  static consentRequired(message = 'Verified guardian consent is required before this can proceed.') {
    return new ApiError('CONSENT_REQUIRED', message);
  }
  static policyViolation(message: string, details?: unknown) {
    return new ApiError('POLICY_VIOLATION', message, details);
  }
  static internal(message = 'Something went wrong on our end.') {
    return new ApiError('INTERNAL', message);
  }
}
