import type { Request, Response } from 'express';
import type { Env } from '../config/env.js';

/**
 * Browsers keep the refresh token in an httpOnly cookie scoped to the auth endpoints, so page
 * scripts (and XSS) can never read it. Native clients (Electron POS, mobile) send
 * `X-Client: native` and receive it in the response body instead.
 */
export const REFRESH_COOKIE = 'rt';

export const isNativeClient = (req: Request) =>
  String(req.headers['x-client'] ?? '').toLowerCase() === 'native';

const cookiePath = (env: Env) => `/${env.API_PREFIX}/auth`;

export function setRefreshCookie(
  res: Response,
  env: Env,
  token: string,
  expires: Date,
) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: cookiePath(env),
    expires,
  });
}

export function clearRefreshCookie(res: Response, env: Env) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: cookiePath(env),
  });
}

export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return undefined;
}

/**
 * Cookie-authenticated calls must come from an allowed origin (SameSite=Strict already blocks
 * cross-site sends; this also covers same-site subdomains).
 */
export const originAllowed = (req: Request, env: Env) => {
  const origin = req.headers.origin;
  return !origin || env.CORS_ORIGINS.includes(origin);
};
