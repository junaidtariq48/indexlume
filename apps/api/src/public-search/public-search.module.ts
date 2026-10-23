import { Module } from '@nestjs/common';

import { TypesenseModule } from '../typesense/typesense.module.js';
import { PublicSearchKeyGuard } from './public-search-key.guard.js';
import { PublicSearchController } from './public-search.controller.js';
import { PublicSearchService } from './public-search.service.js';
import { SearchKeysController } from './search-keys.controller.js';
import { SearchKeysService } from './search-keys.service.js';

@Module({
  imports: [TypesenseModule],
  controllers: [SearchKeysController, PublicSearchController],
  providers: [SearchKeysService, PublicSearchKeyGuard, PublicSearchService],
})
export class PublicSearchModule {}
