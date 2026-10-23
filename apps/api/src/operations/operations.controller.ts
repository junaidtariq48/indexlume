import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  analyticsQuerySchema,
  auditQuerySchema,
  type AnalyticsQuery,
  type AuditQuery,
} from '@osc/contracts';

import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OperationsService } from './operations.service.js';

@Controller('projects/:projectId')
export class OperationsController {
  constructor(
    @Inject(OperationsService)
    private readonly operations: OperationsService,
  ) {}

  @Get('analytics')
  analytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.operations.analytics(user.id, projectId, query);
  }

  @Get('audit')
  audit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
  ) {
    return this.operations.audit(user.id, projectId, query);
  }
}
