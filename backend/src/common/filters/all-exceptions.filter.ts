import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AppException,
  type ErrorCode,
  type ErrorDetail,
} from '../errors/app-exception.js';

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
  };
};

const codeForStatus: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

type PrismaKnownError = {
  name: string;
  code: string;
  meta?: Record<string, unknown>;
};
const isPrismaKnownError = (e: unknown): e is PrismaKnownError =>
  typeof e === 'object' &&
  e !== null &&
  (e as { name?: unknown }).name === 'PrismaClientKnownRequestError';

/** Body-parser failures (malformed JSON, oversized body) arrive as plain errors with a status. */
type HttpishError = {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
  message?: string;
};

/**
 * Formats every error as `{ error: { code, message, details?, requestId } }` and never leaks
 * internals: unknown errors become a generic 500 and are logged with the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string | number }>();
    const res = ctx.getResponse<Response>();
    const requestId = req.id === undefined ? undefined : String(req.id);

    const { status, code, message, details } = this.describe(exception);
    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId, path: req.originalUrl },
        'Unhandled error',
      );
    }

    const body: ErrorBody = {
      error: {
        code,
        message,
        ...(details?.length ? { details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(status).json(body);
  }

  private describe(e: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[] | undefined;
  } {
    if (e instanceof AppException) {
      return {
        status: e.getStatus(),
        code: e.code,
        message: e.message,
        details: e.details,
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const res = e.getResponse();
      const raw =
        typeof res === 'string' ? res : (res as { message?: unknown }).message;
      const message = Array.isArray(raw)
        ? raw.join('; ')
        : typeof raw === 'string'
          ? raw
          : e.message;
      return {
        status,
        code: codeForStatus[status] ?? (status >= 500 ? 'INTERNAL' : 'ERROR'),
        message: status >= 500 ? 'Something went wrong.' : message,
      };
    }
    if (isPrismaKnownError(e)) {
      if (e.code === 'P2002')
        return {
          status: HttpStatus.CONFLICT,
          code: 'ALREADY_EXISTS',
          message: 'A record with these details already exists.',
        };
      if (e.code === 'P2025')
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Not found.',
        };
      if (e.code === 'P2003')
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'This record is referenced by other records.',
        };
    }
    const h = e as HttpishError | null;
    const s = h?.status ?? h?.statusCode;
    if (typeof s === 'number' && s >= 400 && s < 500) {
      const message =
        h?.type === 'entity.parse.failed'
          ? 'Malformed JSON body.'
          : h?.expose && h.message
            ? h.message
            : 'Bad request.';
      return { status: s, code: codeForStatus[s] ?? 'BAD_REQUEST', message };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL',
      message: 'Something went wrong.',
    };
  }
}
