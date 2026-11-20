import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../common/errors/app-exception.js';
import { AccessService } from '../access/access.service.js';
import { TokenService } from './token.service.js';
import { assertPermission } from './auth-context.js';
import {
  ALLOW_READ_ONLY,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
  type AuthedRequest,
} from './decorators.js';
import type { PermissionKey } from '../access/permissions.js';

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 * Populates `req.auth` and enforces @RequirePermissions().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppException(
        'UNAUTHENTICATED',
        'Sign in to continue.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    req.auth = await this.access.resolve(this.tokens.verifyAccess(token));

    // A lapsed subscription makes the business read-only: data stays visible and exportable.
    if (
      !req.auth.subscription.writable &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY, targets)
    )
      throw new AppException(
        'SUBSCRIPTION_INACTIVE',
        req.auth.subscription.status === 'EXPIRED'
          ? 'The subscription has lapsed. Renew it to record new sales, stock and purchases — your data is safe and still visible.'
          : 'This business account is read-only. Renew the subscription to continue.',
        HttpStatus.PAYMENT_REQUIRED,
      );

    const required =
      this.reflector.getAllAndOverride<PermissionKey[]>(
        REQUIRED_PERMISSIONS,
        targets,
      ) ?? [];
    for (const p of required) assertPermission(req.auth, p);
    return true;
  }
}
