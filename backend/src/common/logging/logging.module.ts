import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';

/** Client-supplied ids are accepted only if they look like ids (no log injection). */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFor(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const header = req.headers['x-request-id'];
  const given = Array.isArray(header) ? header[0] : header;
  const id = given && SAFE_ID.test(given) ? given : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

/**
 * Structured JSON logs (pino) with a correlation id on every line. Secrets in headers and
 * bodies are redacted; health probes aren't logged.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          genReqId: requestIdFor,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.pin',
              '*.refreshToken',
            ],
            censor: '[redacted]',
          },
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              (req.url ?? '').includes('/health'),
          },
          customLogLevel: (
            _req: IncomingMessage,
            res: ServerResponse,
            err?: Error,
          ) =>
            err || res.statusCode >= 500
              ? 'error'
              : res.statusCode >= 400
                ? 'warn'
                : 'info',
          serializers: {
            req: (req: { id: unknown; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          ...(env.NODE_ENV === 'development'
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true },
                },
              }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
