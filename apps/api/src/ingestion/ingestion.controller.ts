import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  rebuildIndexRequestSchema,
  reconciliationExecuteRequestSchema,
  uploadMetadataSchema,
  type RebuildIndexRequest,
  type ReconciliationExecuteRequest,
  type UploadMetadata,
} from '@osc/contracts';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IngestionService } from './ingestion.service.js';
interface UploadFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@Controller()
export class IngestionController {
  constructor(
    @Inject(IngestionService) private readonly ingestion: IngestionService,
  ) {}
  @Get('projects/:projectId/uploads') list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.listSources(user.id, id);
  }
  @Post('projects/:projectId/uploads')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25_000_000, files: 1 } }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(uploadMetadataSchema)) body: UploadMetadata,
    @UploadedFile() file?: UploadFile,
  ) {
    return this.ingestion.upload(user.id, id, body, file);
  }
  @Post('indexes/:indexId/rebuild') rebuild(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rebuildIndexRequestSchema))
    body: RebuildIndexRequest,
  ) {
    return this.ingestion.rebuild(user.id, id, body);
  }
  @Post('indexes/:indexId/sync') sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.sync(user.id, id);
  }
  @Post('indexes/:indexId/reconcile/preview') reconcilePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.reconcilePreview(user.id, id);
  }
  @Post('indexes/:indexId/reconcile/execute') reconcileExecute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(reconciliationExecuteRequestSchema))
    body: ReconciliationExecuteRequest,
  ) {
    return this.ingestion.reconcileExecute(user.id, id, body.token);
  }
  @Get('indexes/:indexId/runs') runs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('indexId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.listRuns(user.id, id);
  }
  @Get('runs/:runId') run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.getRun(user.id, id);
  }
  @Get('runs/:runId/errors') errors(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.errors(user.id, id);
  }
  @Get('runs/:runId/reconciliation') reconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.reconciliation(user.id, id);
  }
  @Post('runs/:runId/retry-failed') retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.retry(user.id, id);
  }
  @Post('runs/:runId/cancel') cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) id: string,
  ) {
    return this.ingestion.cancel(user.id, id);
  }
}
