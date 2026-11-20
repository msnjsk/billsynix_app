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
import { MembershipsService } from './memberships.service.js';
import {
  createMembershipSchema,
  listMembershipsQuery,
  updateMembershipSchema,
  type CreateMembershipInput,
  type ListMembershipsQuery,
  type UpdateMembershipInput,
} from './memberships.schemas.js';

@ApiTags('members')
@ApiBearerAuth()
@Controller()
export class MembershipsController {
  constructor(private readonly members: MembershipsService) {}

  @Get('memberships')
  @RequirePermissions('users:manage')
  @ApiOperation({
    summary: 'Staff of the business (branch managers see their branches only)',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listMembershipsQuery }) q: ListMembershipsQuery,
  ) {
    return this.members.list(auth, q);
  }

  @Post('memberships')
  @RequirePermissions('users:manage')
  @ApiOperation({
    summary: 'Add a staff member',
    description:
      'Creates the account, or links an existing account with the same email (its password is kept).',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createMembershipSchema }) body: CreateMembershipInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.members.create(auth, body, meta);
  }

  @Get('memberships/:membershipId')
  @RequirePermissions('users:manage')
  @ApiOperation({ summary: 'One staff member' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('membershipId', { schema: uuidParam }) id: string,
  ) {
    return this.members.get(auth, id);
  }

  @Patch('memberships/:membershipId')
  @RequirePermissions('users:manage')
  @ApiOperation({ summary: 'Change roles, branches, status or counter PIN' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('membershipId', { schema: uuidParam }) id: string,
    @Body({ schema: updateMembershipSchema }) body: UpdateMembershipInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.members.update(auth, id, body, meta);
  }

  @Get('roles')
  @RequirePermissions('users:manage')
  @ApiOperation({ summary: 'Roles and their permissions' })
  roles(@CurrentAuth() auth: AuthContext) {
    return this.members.roles(auth);
  }
}
