import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LivenessResponse, ReadinessResponse } from '@osc/contracts';

import { Public } from '../auth/auth.decorators.js';
import { HealthService } from './health.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly healthService: HealthService,
  ) {}

  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const result = await this.healthService.check();

    if (result.status !== 'ready') {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
