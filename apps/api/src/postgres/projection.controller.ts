import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createProjectionRequestSchema,
  projectionPreviewRequestSchema,
  projectionPublishRequestSchema,
  projectionReconcileConfirmRequestSchema,
  projectionVersionActionSchema,
  updateProjectionVersionRequestSchema,
  type CreateProjectionRequest,
  type ProjectionPreviewRequest,
  type ProjectionPublishRequest,
  type ProjectionReconcileConfirmRequest,
  type ProjectionVersionAction,
  type UpdateProjectionVersionRequest,
} from '@osc/ingestion';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProjectionService } from './projection.service.js';

@Controller()
export class ProjectionController {
  constructor(
    @Inject(ProjectionService)
    private readonly projections: ProjectionService,
  ) {}

  @Get('projects/:projectId/projections')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.projections.list(user.id, projectId);
  }

  @Get('projects/:projectId/sources/:sourceId/relations/catalog')
  catalog(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.projections.catalog(user.id, projectId, sourceId);
  }

  @Post('projects/:projectId/projections')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(createProjectionRequestSchema))
    body: CreateProjectionRequest,
  ) {
    return this.projections.create(user.id, projectId, body);
  }

  @Get('projects/:projectId/projections/:projectionId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
  ) {
    return this.projections.get(user.id, projectId, projectionId);
  }

  @Patch('projects/:projectId/projections/:projectionId/versions/:versionId')
  updateVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new ZodValidationPipe(updateProjectionVersionRequestSchema))
    body: UpdateProjectionVersionRequest,
  ) {
    return this.projections.updateVersion(
      user.id,
      projectId,
      projectionId,
      versionId,
      body,
    );
  }

  @Post('projects/:projectId/projections/:projectionId/validate')
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Body(new ZodValidationPipe(projectionVersionActionSchema))
    body: ProjectionVersionAction,
  ) {
    return this.projections.validate(user.id, projectId, projectionId, body);
  }

  @Post('projects/:projectId/projections/:projectionId/preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Body(new ZodValidationPipe(projectionPreviewRequestSchema))
    body: ProjectionPreviewRequest,
  ) {
    return this.projections.preview(user.id, projectId, projectionId, body);
  }

  @Post('projects/:projectId/projections/:projectionId/publish')
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(projectionPublishRequestSchema))
    body: ProjectionPublishRequest,
  ) {
    if (
      !idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    return this.projections.publish(
      user.id,
      projectId,
      projectionId,
      idempotencyKey,
      body,
    );
  }

  @Get('projects/:projectId/projections/:projectionId/generations')
  generations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
  ) {
    return this.projections.generations(user.id, projectId, projectionId);
  }

  @Post('projects/:projectId/projections/:projectionId/sync')
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (
      !idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    return this.projections.sync(
      user.id,
      projectId,
      projectionId,
      idempotencyKey,
    );
  }

  @Post('projects/:projectId/projections/:projectionId/reconcile/preview')
  previewReconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    assertIdempotencyKey(idempotencyKey);
    return this.projections.previewReconciliation(
      user.id,
      projectId,
      projectionId,
      idempotencyKey,
    );
  }

  @Get('projects/:projectId/projections/:projectionId/reconcile/:runId')
  reconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ) {
    return this.projections.reconciliation(
      user.id,
      projectId,
      projectionId,
      runId,
    );
  }

  @Post(
    'projects/:projectId/projections/:projectionId/reconcile/:runId/confirm',
  )
  confirmReconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('projectionId', new ParseUUIDPipe()) projectionId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(projectionReconcileConfirmRequestSchema))
    body: ProjectionReconcileConfirmRequest,
  ) {
    assertIdempotencyKey(idempotencyKey);
    return this.projections.confirmReconciliation(
      user.id,
      projectId,
      projectionId,
      runId,
      idempotencyKey,
      body,
    );
  }
}

function assertIdempotencyKey(
  value: string | undefined,
): asserts value is string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new BadRequestException('A valid Idempotency-Key is required');
  }
}
