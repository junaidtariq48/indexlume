import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  createTypesenseConnectionRequestSchema,
  type CreateTypesenseConnectionRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TypesenseConnectionsService } from './typesense-connections.service.js';

@Controller()
export class TypesenseConnectionsController {
  constructor(
    @Inject(TypesenseConnectionsService)
    private readonly connections: TypesenseConnectionsService,
  ) {}

  @Get('workspaces/:workspaceId/typesense-connections')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
  ) {
    return this.connections.list(user.id, workspaceId);
  }

  @Post('workspaces/:workspaceId/typesense-connections')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(createTypesenseConnectionRequestSchema))
    body: CreateTypesenseConnectionRequest,
  ) {
    return this.connections.create(user.id, workspaceId, body);
  }

  @Post('typesense-connections/:connectionId/test')
  test(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
  ) {
    return this.connections.test(user.id, connectionId);
  }
}
