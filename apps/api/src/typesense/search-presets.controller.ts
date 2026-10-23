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
  createSearchPresetRequestSchema,
  updateSearchPresetRequestSchema,
  type CreateSearchPresetRequest,
  type UpdateSearchPresetRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchPresetsService } from './search-presets.service.js';

@Controller()
export class SearchPresetsController {
  constructor(
    @Inject(SearchPresetsService)
    private readonly presets: SearchPresetsService,
  ) {}

  @Get('indexes/:indexId/presets')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
  ) {
    return this.presets.list(user.id, indexId);
  }

  @Post('indexes/:indexId/presets')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) indexId: string,
    @Body(new ZodValidationPipe(createSearchPresetRequestSchema))
    body: CreateSearchPresetRequest,
  ) {
    return this.presets.create(user.id, indexId, body);
  }

  @Patch('presets/:presetId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('presetId', new ParseUUIDPipe()) presetId: string,
    @Body(new ZodValidationPipe(updateSearchPresetRequestSchema))
    body: UpdateSearchPresetRequest,
  ) {
    return this.presets.update(user.id, presetId, body);
  }

  @Delete('presets/:presetId')
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('presetId', new ParseUUIDPipe()) presetId: string,
  ) {
    return this.presets.delete(user.id, presetId);
  }
}
