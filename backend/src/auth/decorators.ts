import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionKey } from '../access/permissions.js';
import type { AuthContext } from './auth-context.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSIONS = 'auth:permissions';

/** Opts a route out of authentication (registration, health). Everything else requires a token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_READ_ONLY = 'auth:allow-read-only';
/**
 * Works even while the business is read-only (subscription lapsed, Phase 10): signing out, paying,
 * synchronising bills a counter already made offline, closing a drawer.
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY, true);

/** Caller must hold every listed permission (branch scope is checked by the service). */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export type AuthedRequest = Request & {
  auth?: AuthContext;
  id?: string | number;
};

/** The authenticated caller's context (set by AuthGuard). */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw new Error('CurrentAuth used on a public route');
    return req.auth;
  },
);

export type RequestMeta = {
  requestId?: string;
  ip?: string;
  userAgent?: string;
};

/** Request id, client IP and user agent — for audit records and session details. */
export const ReqMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return {
      ...(req.id !== undefined ? { requestId: String(req.id) } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.headers['user-agent']
        ? { userAgent: req.headers['user-agent'] }
        : {}),
    };
  },
);
