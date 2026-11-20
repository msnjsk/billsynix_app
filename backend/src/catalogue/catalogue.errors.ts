import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception.js';

export const notFound = (what: string) =>
  new AppException('NOT_FOUND', `${what} not found.`, HttpStatus.NOT_FOUND);

/** 422 — a business rule rejected the request. */
export const unprocessable = (code: string, message: string, field?: string) =>
  new AppException(
    code,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    field ? [{ field, issue: message }] : undefined,
  );

export const alreadyExists = (message: string, field: string) =>
  new AppException('ALREADY_EXISTS', message, HttpStatus.CONFLICT, [
    { field, issue: 'taken' },
  ]);

export const inUse = (message: string) =>
  new AppException('IN_USE', message, HttpStatus.CONFLICT);

/** Unique-index violation (P2002) — used to turn a race into the friendly 409. */
export const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === 'P2002';
