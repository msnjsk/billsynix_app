import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AllowWhenReadOnly,
  CurrentAuth,
  Public,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AUTH_THROTTLE, deliverSession } from '../auth/auth.controller.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { TenantsService } from './tenants.service.js';
import { MAX_IMAGE_BYTES } from '../catalogue/products.service.js';
import {
  addBusinessSchema,
  registerTenantSchema,
  updateTenantSchema,
  type AddBusinessInput,
  type RegisterTenantInput,
  type UpdateTenantInput,
} from './tenants.schemas.js';

const nativeHeader = {
  name: 'X-Client',
  required: false,
  description:
    '`native` to receive the refresh token in the body instead of an httpOnly cookie',
};

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post()
  @ApiHeader(nativeHeader)
  @ApiOperation({
    summary: 'Register a business (new account)',
    description:
      'Creates the owner account, the business, system roles, the head-office branch and Counter 1, and signs the owner in.',
  })
  @ApiCreatedResponse({
    description: 'Business registered and owner signed in',
  })
  @ApiConflictResponse({
    description:
      'Email already registered — sign in and use /tenants/additional',
  })
  async register(
    @Body({ schema: registerTenantSchema }) body: RegisterTenantInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverSession(
      req,
      res,
      this.env,
      await this.tenants.register(body, meta),
    );
  }

  @ApiBearerAuth()
  @AllowWhenReadOnly() // a new business has its own (trial) subscription
  @Post('additional')
  @ApiHeader(nativeHeader)
  @ApiOperation({
    summary: 'Open another business with your existing account',
    description:
      'You become its owner. Returns a session for the new business.',
  })
  async addBusiness(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: addBusinessSchema }) body: AddBusinessInput,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverSession(
      req,
      res,
      this.env,
      await this.tenants.addBusiness(auth, body, meta),
    );
  }

  @ApiBearerAuth()
  @Get('current')
  @RequirePermissions('tenant:read')
  @ApiOperation({ summary: 'The business the caller is signed in to' })
  current(@CurrentAuth() auth: AuthContext) {
    return this.tenants.current(auth);
  }

  @ApiBearerAuth()
  @Patch('current')
  @RequirePermissions('tenant:update')
  @ApiOperation({ summary: 'Update the business profile' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: updateTenantSchema }) body: UpdateTenantInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tenants.update(auth, body, meta);
  }

  @ApiBearerAuth()
  @Put('current/logo')
  @RequirePermissions('tenant:update')
  @UseInterceptors(FileInterceptor('logo', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { logo: { type: 'string', format: 'binary', description: 'JPEG, PNG or WebP, up to 2 MB' } }, required: ['logo'] } })
  @ApiOperation({ summary: 'Set the shop logo (receipts, app header)' })
  putLogo(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tenants.putLogo(auth, file, meta);
  }

  @ApiBearerAuth()
  @Get('current/logo')
  @RequirePermissions('tenant:read')
  @ApiOperation({ summary: 'The shop logo', description: 'The image bytes, or a redirect to a short-lived link when files are in S3.' })
  async getLogo(@CurrentAuth() auth: AuthContext, @Res() res: Response) {
    const found = await this.tenants.getLogo(auth);
    if (found.kind === 'redirect') {
      res.redirect(302, found.url);
      return;
    }
    res
      .status(200)
      .set({ 'Content-Type': found.contentType, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'" })
      .send(found.body);
  }

  @ApiBearerAuth()
  @Delete('current/logo')
  @RequirePermissions('tenant:update')
  @ApiOperation({ summary: 'Remove the shop logo' })
  deleteLogo(@CurrentAuth() auth: AuthContext, @ReqMeta() meta: RequestMeta) {
    return this.tenants.deleteLogo(auth, meta);
  }
}
