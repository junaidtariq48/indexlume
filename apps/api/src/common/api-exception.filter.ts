import type { ArgumentsHost } from '@nestjs/common';
import {
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const prismaCode = this.prismaCode(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : prismaCode === 'P2002'
          ? HttpStatus.CONFLICT
          : prismaCode === 'P2025'
            ? HttpStatus.NOT_FOUND
            : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : typeof exceptionResponse === 'object' && exceptionResponse
          ? String(
              (exceptionResponse as { message?: unknown }).message ??
                'Request failed',
            )
          : status === HttpStatus.INTERNAL_SERVER_ERROR
            ? 'Internal server error'
            : 'Request failed';
    const details =
      typeof exceptionResponse === 'object' && exceptionResponse
        ? (exceptionResponse as { issues?: unknown }).issues
        : undefined;

    response.status(status).json({
      error: {
        code: this.errorCode(status),
        message,
        requestId: String(request.headers['x-request-id'] ?? 'unknown'),
        ...(details ? { details } : {}),
      },
    });
  }

  private prismaCode(exception: unknown): string | undefined {
    if (typeof exception !== 'object' || exception === null) return undefined;
    const code = (exception as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  private errorCode(status: number): string {
    return (
      {
        400: 'VALIDATION_ERROR',
        401: 'UNAUTHENTICATED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        413: 'PAYLOAD_TOO_LARGE',
        422: 'UNPROCESSABLE_ENTITY',
        429: 'RATE_LIMITED',
      }[status] ?? 'INTERNAL_ERROR'
    );
  }
}
