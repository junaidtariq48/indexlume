import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import {
  setupOwnerRequestSchema,
  type SetupOwnerRequest,
} from '@osc/contracts';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Public } from './auth.decorators.js';
import { SetupService } from './setup.service.js';

@Public()
@Controller('setup')
export class SetupController {
  constructor(
    @Inject(SetupService) private readonly setupService: SetupService,
  ) {}

  @Get('status')
  status() {
    return this.setupService.status();
  }

  @Post('owner')
  createOwner(
    @Body(new ZodValidationPipe(setupOwnerRequestSchema))
    body: SetupOwnerRequest,
    @Headers('x-setup-token') setupToken?: string,
  ) {
    return this.setupService.createOwner(body, setupToken);
  }
}
