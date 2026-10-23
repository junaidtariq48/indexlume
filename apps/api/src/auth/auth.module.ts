import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

@Module({
  controllers: [AuthController, SetupController],
  providers: [AuthService, SetupService],
})
export class AuthModule {}
