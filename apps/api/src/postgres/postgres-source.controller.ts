import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  configurePostgresSourceRequestSchema,
  createPostgresSourceRequestSchema,
  postgresPreviewRequestSchema,
  type ConfigurePostgresSourceRequest,
  type CreatePostgresSourceRequest,
  type PostgresPreviewRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PostgresSourceService } from './postgres-source.service.js';

@Controller()
export class PostgresSourceController {
  constructor(
    @Inject(PostgresSourceService)
    private readonly sources: PostgresSourceService,
  ) {}

  @Get('projects/:projectId/sources')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.sources.list(user.id, projectId);
  }

  @Post('projects/:projectId/sources')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(createPostgresSourceRequestSchema))
    body: CreatePostgresSourceRequest,
  ) {
    return this.sources.create(user.id, projectId, body);
  }

  @Post('sources/:sourceId/test')
  test(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.sources.test(user.id, sourceId);
  }

  @Get('sources/:sourceId/datasets')
  datasets(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.sources.datasets(user.id, sourceId);
  }

  @Post('sources/:sourceId/preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body(new ZodValidationPipe(postgresPreviewRequestSchema))
    body: PostgresPreviewRequest,
  ) {
    return this.sources.preview(user.id, sourceId, body);
  }

  @Patch('sources/:sourceId')
  configure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body(new ZodValidationPipe(configurePostgresSourceRequestSchema))
    body: ConfigurePostgresSourceRequest,
  ) {
    return this.sources.configure(user.id, sourceId, body);
  }

  @Delete('sources/:sourceId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.sources.remove(user.id, sourceId);
  }
}
