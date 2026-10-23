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
  createSearchKeyRequestSchema,
  type CreateSearchKeyRequest,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchKeysService } from './search-keys.service.js';

@Controller()
export class SearchKeysController {
  constructor(
    @Inject(SearchKeysService) private readonly keys: SearchKeysService,
  ) {}

  @Get('projects/:projectId/search-keys')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.keys.list(user.id, projectId);
  }

  @Post('projects/:projectId/search-keys')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(createSearchKeyRequestSchema))
    body: CreateSearchKeyRequest,
  ) {
    return this.keys.create(user.id, projectId, body);
  }

  @Post('search-keys/:keyId/revoke')
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('keyId', new ParseUUIDPipe()) keyId: string,
  ) {
    return this.keys.revoke(user.id, keyId);
  }
}
