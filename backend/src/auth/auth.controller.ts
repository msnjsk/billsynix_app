import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ENV } from '../config/config.module.js';
import { getEnv, type Env } from '../config/env.js';
import { AppException } from '../common/errors/app-exception.js';
import { uuidParam } from '../common/schemas.js';
import type { AuthContext } from './auth-context.js';
import {
  CurrentAuth,
  AllowWhenReadOnly,
  Public,
  ReqMeta,
  type RequestMeta,
} from './decorators.js';
import { AuthService } from './auth.service.js';
import { SessionService, type IssuedSession } from './session.service.js';
import {
  clearRefreshCookie,
  isNativeClient,
  originAllowed,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  pinLoginSchema,
  refreshSchema,
  resetPasswordSchema,
  switchTenantSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginInput,
  type PinLoginInput,
  type RefreshInput,
  type ResetPasswordInput,
  type SwitchTenantInput,
} from './auth.schemas.js';

/** Strict per-IP limit for anything that checks a secret. */
export const AUTH_THROTTLE = {
  default: { limit: () => getEnv().AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 },
};

const nativeHeader = {
  name: 'X-Client',
  required: false,
  description:
    '`native` to receive the refresh token in the body instead of an httpOnly cookie',
};

/**
 * Hands a new session to the client: native apps get the refresh token in the body, browsers
 * only ever see it as an httpOnly cookie.
 */
export function deliverSession<T extends IssuedSession>(
  req: Request,
  res: Response,
  env: Env,
  issued: T,
) {
  const { refreshToken, refreshExpiresAt, ...rest } = issued;
  if (isNativeClient(req)) return { ...rest, refreshToken, refreshExpiresAt };
  setRefreshCookie(res, env, refreshToken, refreshExpiresAt);
  return { ...rest, refreshExpiresAt };
}

@ApiTags('auth')
// Signing in and out, switching business and passwords work even while a business is read-only.
@AllowWhenReadOnly()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Refresh token from the body (native) or cookie (browser, origin-checked). */
  private refreshTokenFrom(
    req: Request,
    body: RefreshInput,
  ): string | undefined {
    if (body.refreshToken) return body.refreshToken;
    const cookie = readRefreshCookie(req);
    if (cookie && !originAllowed(req, this.env)) {
      throw new AppException(
        'FORBIDDEN_ORIGIN',
        'Request origin is not allowed.',
        HttpStatus.FORBIDDEN,
      );
    }
    return cookie;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(nativeHeader)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Returns `status: AUTHENTICATED` with tokens, or `status: SELECT_TENANT` with the businesses to choose from (repeat with `tenantId`). Five wrong passwords lock the account for 15 minutes.',
  })
  async login(
    @Body({ schema: loginSchema }) body: LoginInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, meta);
    return result.status === 'AUTHENTICATED'
      ? deliverSession(req, res, this.env, result)
      : result;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(nativeHeader)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Each refresh token works once. Re-using one signs out the whole session family.',
  })
  async refresh(
    @Body({ schema: refreshSchema }) body: RefreshInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, body);
    if (!token)
      throw new AppException(
        'INVALID_REFRESH_TOKEN',
        'Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    try {
      return deliverSession(
        req,
        res,
        this.env,
        await this.sessions.rotate(token, meta),
      );
    } catch (e) {
      clearRefreshCookie(res, this.env);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out this session (works with an expired access token)',
  })
  async logout(
    @Body({ schema: refreshSchema }) body: RefreshInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, body);
    clearRefreshCookie(res, this.env);
    if (token)
      await this.sessions
        .revokeByRefreshToken(token)
        .then((s) => s && this.auth.recordLogout(s, meta));
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out everywhere (every device, every business)',
  })
  async logoutAll(
    @CurrentAuth() auth: AuthContext,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    clearRefreshCookie(res, this.env);
    await this.auth.logoutEverywhere(auth, meta);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Who am I: user, business, roles, permissions, branches, session',
  })
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @ApiBearerAuth()
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(nativeHeader)
  @ApiOperation({ summary: 'Get a session for another business you belong to' })
  async switchTenant(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: switchTenantSchema }) body: SwitchTenantInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverSession(
      req,
      res,
      this.env,
      await this.auth.switchTenant(auth, body.tenantId, meta),
    );
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Your signed-in sessions' })
  listSessions(@CurrentAuth() auth: AuthContext) {
    return this.auth.listSessions(auth);
  }

  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out one of your sessions' })
  revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.revokeSession(auth, id, meta);
  }

  @ApiBearerAuth()
  @Throttle(AUTH_THROTTLE)
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change your password (signs out your other sessions)',
  })
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: changePasswordSchema }) body: ChangePasswordInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.changePassword(auth, body, meta);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Email a password-reset link (same answer whether or not the email exists)',
  })
  async forgotPassword(
    @Body({ schema: forgotPasswordSchema }) body: ForgotPasswordInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.forgotPassword(body.email, meta);
    return {
      message:
        'If an account exists for that email, a reset link is on its way.',
    };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password from a reset link (signs out every session)',
  })
  resetPassword(
    @Body({ schema: resetPasswordSchema }) body: ResetPasswordInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.resetPassword(body, meta);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Get('device/cashiers')
  @ApiHeader({
    name: 'X-Device-Key',
    required: true,
    description: 'Key issued when the device was registered',
  })
  @ApiOperation({
    summary: "Names shown on a registered POS device's sign-in screen",
  })
  deviceCashiers(@Req() req: Request) {
    return this.auth.deviceCashiers(req.header('x-device-key'));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('pin-login')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'X-Device-Key',
    required: true,
    description: 'Key issued when the device was registered',
  })
  @ApiOperation({
    summary: 'Cashier PIN sign-in on a registered POS device',
    description:
      'The session lasts one shift and is limited to the device’s branch. Five wrong PINs lock that PIN for 15 minutes.',
  })
  async pinLogin(
    @Body({ schema: pinLoginSchema }) body: PinLoginInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverSession(
      req,
      res,
      this.env,
      await this.auth.pinLogin(req.header('x-device-key'), body, meta),
    );
  }
}
