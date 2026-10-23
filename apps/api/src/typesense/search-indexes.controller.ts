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
  Query,
} from '@nestjs/common';
import {
  createSearchIndexRequestSchema,
  playgroundSearchRequestSchema,
  updateSearchIndexRequestSchema,
  type CreateSearchIndexRequest,
  type PlaygroundSearchRequest,
  type UpdateSearchIndexRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchIndexesService } from './search-indexes.service.js';

@Controller()
export class SearchIndexesController {
  constructor(
    @Inject(SearchIndexesService)
    private readonly indexes: SearchIndexesService,
  ) {}

  @Get('projects/:projectId/indexes')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.indexes.list(user.id, projectId);
  }

  @Post('projects/:projectId/indexes')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(createSearchIndexRequestSchema))
    body: CreateSearchIndexRequest,
  ) {
    return this.indexes.create(user.id, projectId, body);
  }

  @Get('indexes/:indexId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
  ) {
    return this.indexes.get(user.id, indexId);
  }

  @Patch('indexes/:indexId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
    @Body(new ZodValidationPipe(updateSearchIndexRequestSchema))
    body: UpdateSearchIndexRequest,
  ) {
    return this.indexes.update(user.id, indexId, body);
  }

  @Delete('indexes/:indexId')
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
    @Query('confirm') confirmation?: string,
  ) {
    return this.indexes.delete(user.id, indexId, confirmation);
  }

  @Post('indexes/:indexId/playground/search')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
    @Body(new ZodValidationPipe(playgroundSearchRequestSchema))
    body: PlaygroundSearchRequest,
  ) {
    return this.indexes.search(user.id, indexId, body);
  }
}
