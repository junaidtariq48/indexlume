import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller.js';
import { IngestionQueueService } from './ingestion-queue.service.js';
import { IngestionService } from './ingestion.service.js';

@Module({
  controllers: [IngestionController],
  providers: [IngestionQueueService, IngestionService],
  exports: [IngestionQueueService],
})
export class IngestionModule {}
