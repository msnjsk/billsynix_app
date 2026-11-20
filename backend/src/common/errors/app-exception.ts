import { HttpException, HttpStatus } from '@nestjs/common';

/** Machine-readable error codes (docs/phase-0/05-api-conventions.md). */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL'
  | (string & {});

export type ErrorDetail = { field?: string; issue: string };

/** Throw this from services for any expected failure; the global filter formats it. */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: ErrorDetail[],
  ) {
    super(message, status);
  }
}
