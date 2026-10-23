import { Module } from '@nestjs/common';

import { EncryptionService } from './encryption.service.js';
import { SearchIndexesController } from './search-indexes.controller.js';
import { SearchIndexesService } from './search-indexes.service.js';
import { SearchPresetsController } from './search-presets.controller.js';
import { SearchPresetsService } from './search-presets.service.js';
import { TypesenseConnectionsController } from './typesense-connections.controller.js';
import { TypesenseConnectionsService } from './typesense-connections.service.js';
import { TypesenseGateway } from './typesense.gateway.js';

@Module({
  controllers: [
    TypesenseConnectionsController,
    SearchIndexesController,
    SearchPresetsController,
  ],
  providers: [
    EncryptionService,
    TypesenseGateway,
    TypesenseConnectionsService,
    SearchIndexesService,
    SearchPresetsService,
  ],
  exports: [EncryptionService, TypesenseGateway, TypesenseConnectionsService],
})
export class TypesenseModule {}
