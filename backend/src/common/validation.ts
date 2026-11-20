import { HttpStatus, StandardSchemaValidationPipe } from '@nestjs/common';
import { AppException } from './errors/app-exception.js';

/**
 * Validates every `@Body({ schema })`, `@Query({ schema })` and `@Param(name, { schema })`
 * with its Zod schema and reports failures in the standard error format.
 */
export const validationPipe = () =>
  new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new AppException(
        'VALIDATION_FAILED',
        'Request validation failed.',
        HttpStatus.BAD_REQUEST,
        issues.map((issue) => ({
          ...(issue.path?.length
            ? {
                field: issue.path
                  .map((s) =>
                    typeof s === 'object' ? String(s.key) : String(s),
                  )
                  .join('.'),
              }
            : {}),
          issue: issue.message,
        })),
      ),
  });
