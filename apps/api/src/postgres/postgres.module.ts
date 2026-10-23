import { Module } from '@nestjs/common';

import { TypesenseModule } from '../typesense/typesense.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { PostgresSourceController } from './postgres-source.controller.js';
import { PostgresSourceService } from './postgres-source.service.js';
import { ProjectionController } from './projection.controller.js';
import { ProjectionService } from './projection.service.js';

@Module({
  imports: [TypesenseModule, IngestionModule],
  controllers: [PostgresSourceController, ProjectionController],
  providers: [PostgresSourceService, ProjectionService],
  exports: [PostgresSourceService],
})
export class PostgresModule {}
