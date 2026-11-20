import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { StoresService } from './stores.service.js';
import {
  createCounterSchema,
  createStoreSchema,
  listStoresQuery,
  registerDeviceSchema,
  updateCounterSchema,
  updateStoreSchema,
  type CreateCounterInput,
  type CreateStoreInput,
  type ListStoresQuery,
  type RegisterDeviceInput,
  type UpdateCounterInput,
  type UpdateStoreInput,
} from './stores.schemas.js';

@ApiTags('stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @ApiOperation({ summary: 'Branches the caller can access' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listStoresQuery }) q: ListStoresQuery,
  ) {
    return this.stores.list(auth, q);
  }

  @Post()
  @RequirePermissions('stores:manage')
  @ApiOperation({ summary: 'Create a branch (store or warehouse)' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createStoreSchema }) body: CreateStoreInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.create(auth, body, meta);
  }

  @Get(':storeId')
  @ApiOperation({ summary: 'One branch' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
  ) {
    return this.stores.get(auth, storeId);
  }

  @Patch(':storeId')
  @RequirePermissions('stores:manage')
  @ApiOperation({ summary: 'Edit a branch' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Body({ schema: updateStoreSchema }) body: UpdateStoreInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.update(auth, storeId, body, meta);
  }

  @Post(':storeId/close')
  @RequirePermissions('stores:manage')
  @ApiOperation({
    summary:
      'Close a branch (keeps its history; disables counters and devices)',
  })
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.close(auth, storeId, meta);
  }

  @Get(':storeId/counters')
  @ApiOperation({ summary: 'Counters of a branch' })
  counters(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
  ) {
    return this.stores.listCounters(auth, storeId);
  }

  @Post(':storeId/counters')
  @RequirePermissions('counters:manage')
  @ApiOperation({
    summary: 'Add a counter (numbers 1–9 form the invoice series)',
  })
  createCounter(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Body({ schema: createCounterSchema }) body: CreateCounterInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.createCounter(auth, storeId, body, meta);
  }

  @Get(':storeId/devices')
  @RequirePermissions('devices:register')
  @ApiOperation({ summary: 'POS devices registered in a branch' })
  devices(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
  ) {
    return this.stores.listDevices(auth, storeId);
  }
}

@ApiTags('stores')
@ApiBearerAuth()
@Controller()
export class CountersController {
  constructor(private readonly stores: StoresService) {}

  @Patch('counters/:counterId')
  @RequirePermissions('counters:manage')
  @ApiOperation({ summary: 'Rename or enable/disable a counter' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('counterId', { schema: uuidParam }) counterId: string,
    @Body({ schema: updateCounterSchema }) body: UpdateCounterInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.updateCounter(auth, counterId, body, meta);
  }

  @Post('counters/:counterId/devices')
  @RequirePermissions('devices:register')
  @ApiOperation({
    summary: 'Register a POS device for a counter',
    description:
      'Returns `deviceKey` once. Store it on the device; it cannot be retrieved again.',
  })
  registerDevice(
    @CurrentAuth() auth: AuthContext,
    @Param('counterId', { schema: uuidParam }) counterId: string,
    @Body({ schema: registerDeviceSchema }) body: RegisterDeviceInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.registerDevice(auth, counterId, body, meta);
  }

  @Post('devices/:deviceId/revoke')
  @RequirePermissions('devices:register')
  @ApiOperation({ summary: 'Revoke a POS device' })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('deviceId', { schema: uuidParam }) deviceId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stores.revokeDevice(auth, deviceId, meta);
  }
}
