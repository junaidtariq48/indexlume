import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config.module.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { PostgresModule } from './postgres/postgres.module.js';
import { PublicSearchModule } from './public-search/public-search.module.js';
import { TypesenseModule } from './typesense/typesense.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  imports: [
    ConfigModule,
    InfrastructureModule,
    AuthModule,
    IngestionModule,
    OperationsModule,
    PostgresModule,
    PublicSearchModule,
    TypesenseModule,
    WorkspacesModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
