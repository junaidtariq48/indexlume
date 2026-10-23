import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { apiEnvironmentSchema } from '@osc/contracts';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';

import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';

async function bootstrap(): Promise<void> {
  const config = apiEnvironmentSchema.parse(process.env);
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(new ConsoleLogger({ json: true }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = request.headers['x-request-id'] ?? randomUUID();
    request.headers['x-request-id'] = String(requestId);
    response.setHeader('x-request-id', String(requestId));
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: config.APP_ORIGIN, credentials: true });
  app.use(cookieParser());
  app.use((request: Request, response: Response, next: NextFunction) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const hasSessionCookie = Boolean(request.cookies?.osc_session);
    if (
      mutating &&
      hasSessionCookie &&
      request.headers.origin !== config.APP_ORIGIN
    ) {
      response.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid request origin',
          requestId: String(request.headers['x-request-id']),
        },
      });
      return;
    }
    next();
  });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, '0.0.0.0');
}

void bootstrap();
