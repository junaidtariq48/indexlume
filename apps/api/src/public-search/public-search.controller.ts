import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  publicSearchRequestSchema,
  type PublicSearchRequest,
} from '@osc/contracts';

import { Public } from '../auth/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PublicSearchKeyGuard } from './public-search-key.guard.js';
import { PublicSearchService } from './public-search.service.js';
import type { PublicSearchRequestWithContext } from './public-search.types.js';

@Public()
@UseGuards(PublicSearchKeyGuard)
@Controller('search/v1')
export class PublicSearchController {
  constructor(
    @Inject(PublicSearchService)
    private readonly publicSearch: PublicSearchService,
  ) {}

  @Post(':projectPublicId/:indexSlug')
  search(
    @Req() request: PublicSearchRequestWithContext,
    @Param('indexSlug') indexSlug: string,
    @Body(new ZodValidationPipe(publicSearchRequestSchema))
    body: PublicSearchRequest,
  ) {
    return this.publicSearch.search(
      request.publicSearch.projectId,
      indexSlug,
      body,
    );
  }
}
