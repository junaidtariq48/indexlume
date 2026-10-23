import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { loginRequestSchema, type LoginRequest } from '@osc/contracts';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser, Public } from './auth.decorators.js';
import { SESSION_COOKIE } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedUser } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.login(body, request.ip ?? 'unknown', response);
  }

  @Post('logout')
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.logout(
      request.cookies?.[SESSION_COOKIE] as string | undefined,
      response,
    );
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }
}
