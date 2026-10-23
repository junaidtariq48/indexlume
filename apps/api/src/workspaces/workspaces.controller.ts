import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  createMemberRequestSchema,
  createWorkspaceRequestSchema,
  updateMemberRequestSchema,
  updateWorkspaceRequestSchema,
  type CreateMemberRequest,
  type CreateWorkspaceRequest,
  type UpdateMemberRequest,
  type UpdateWorkspaceRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspaces.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createWorkspaceRequestSchema))
    body: CreateWorkspaceRequest,
  ) {
    return this.workspaces.create(user.id, body);
  }

  @Get(':workspaceId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
  ) {
    return this.workspaces.get(user.id, workspaceId);
  }

  @Patch(':workspaceId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema))
    body: UpdateWorkspaceRequest,
  ) {
    return this.workspaces.update(user.id, workspaceId, body);
  }

  @Get(':workspaceId/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
  ) {
    return this.workspaces.listMembers(user.id, workspaceId);
  }

  @Post(':workspaceId/members')
  createMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(createMemberRequestSchema))
    body: CreateMemberRequest,
  ) {
    return this.workspaces.createMember(user.id, workspaceId, body);
  }

  @Patch(':workspaceId/members/:memberId')
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body(new ZodValidationPipe(updateMemberRequestSchema))
    body: UpdateMemberRequest,
  ) {
    return this.workspaces.updateMember(user.id, workspaceId, memberId, body);
  }

  @Delete(':workspaceId/members/:memberId')
  deleteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.workspaces.deleteMember(user.id, workspaceId, memberId);
  }
}
