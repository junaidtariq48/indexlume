import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateTypesenseConnectionRequest } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { EncryptionService } from './encryption.service.js';
import { validateExternalTypesenseEndpoint } from './endpoint-policy.js';
import {
  TypesenseGateway,
  type TypesenseCredentials,
} from './typesense.gateway.js';

@Injectable()
export class TypesenseConnectionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(TypesenseGateway) private readonly gateway: TypesenseGateway,
  ) {}

  async list(userId: string, workspaceId: string) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId);
    const connections = await this.prisma.typesenseConnection.findMany({
      where: { workspaceId },
      select: this.publicSelect(),
      orderBy: { name: 'asc' },
    });
    return { data: connections, meta: {} };
  }

  async create(
    userId: string,
    workspaceId: string,
    input: CreateTypesenseConnectionRequest,
  ) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId, 'ADMIN');
    const details = await this.connectionDetails(input);
    await this.gateway.health({
      endpoint: details.endpoint,
      apiKey: details.apiKey,
    });

    return this.prisma.$transaction(async (transaction) => {
      const connection = await transaction.typesenseConnection.create({
        data: {
          workspaceId,
          name: input.name,
          mode: input.mode,
          endpoint: details.endpoint,
          encryptedApiKey: this.encryption.encrypt(details.apiKey),
          tlsPolicy: details.tlsPolicy,
        },
        select: this.publicSelect(),
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'typesense_connection.created',
          targetType: 'typesense_connection',
          targetId: connection.id,
          metadata: { mode: connection.mode, tlsPolicy: connection.tlsPolicy },
        },
      });
      return connection;
    });
  }

  async test(userId: string, connectionId: string) {
    const connection = await this.prisma.typesenseConnection.findFirst({
      where: {
        id: connectionId,
        workspace: { memberships: { some: { userId } } },
      },
    });
    if (!connection) {
      throw new NotFoundException('Typesense connection not found');
    }
    await requireWorkspaceRole(
      this.prisma,
      connection.workspaceId,
      userId,
      'ADMIN',
    );
    await this.gateway.health(this.credentials(connection));
    await this.prisma.auditLog.create({
      data: {
        workspaceId: connection.workspaceId,
        actorId: userId,
        action: 'typesense_connection.tested',
        targetType: 'typesense_connection',
        targetId: connection.id,
      },
    });
    return { ok: true };
  }

  credentials(connection: {
    endpoint: string;
    encryptedApiKey: string;
  }): TypesenseCredentials {
    return {
      endpoint: connection.endpoint,
      apiKey: this.encryption.decrypt(connection.encryptedApiKey),
    };
  }

  private async connectionDetails(input: CreateTypesenseConnectionRequest) {
    if (input.mode === 'BUNDLED') {
      return {
        endpoint: new URL(this.config.TYPESENSE_URL).origin,
        apiKey: this.config.TYPESENSE_API_KEY,
        tlsPolicy: this.config.TYPESENSE_URL.startsWith('https:')
          ? ('STRICT' as const)
          : ('ALLOW_INSECURE' as const),
      };
    }
    return {
      endpoint: await validateExternalTypesenseEndpoint(
        input.endpoint,
        input.tlsPolicy,
        this.config,
      ),
      apiKey: input.apiKey,
      tlsPolicy: input.tlsPolicy,
    };
  }

  private publicSelect() {
    return {
      id: true,
      workspaceId: true,
      name: true,
      mode: true,
      endpoint: true,
      tlsPolicy: true,
      createdAt: true,
      updatedAt: true,
    } as const;
  }
}
