import { BadGatewayException, Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../app-config.js';

export interface TypesenseCredentials {
  endpoint: string;
  apiKey: string;
}

export interface TypesenseField {
  name: string;
  type: string;
  facet?: boolean;
  optional?: boolean;
  sort?: boolean;
  index?: boolean;
}

interface ImportResult {
  succeeded: number;
  failed: number;
}

@Injectable()
export class TypesenseGateway {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async health(credentials: TypesenseCredentials): Promise<void> {
    const result = await this.request<{ ok?: boolean }>(credentials, '/health');
    if (result.ok !== true) {
      throw new BadGatewayException('Typesense health check failed');
    }
  }

  async createCollection(
    credentials: TypesenseCredentials,
    input: {
      name: string;
      fields: TypesenseField[];
      default_sorting_field?: string;
    },
  ): Promise<void> {
    await this.request(credentials, '/collections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteCollection(
    credentials: TypesenseCredentials,
    name: string,
  ): Promise<void> {
    await this.request(
      credentials,
      `/collections/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      true,
    );
  }

  async upsertAlias(
    credentials: TypesenseCredentials,
    alias: string,
    collectionName: string,
  ): Promise<void> {
    await this.request(credentials, `/aliases/${encodeURIComponent(alias)}`, {
      method: 'PUT',
      body: JSON.stringify({ collection_name: collectionName }),
    });
  }

  async deleteAlias(
    credentials: TypesenseCredentials,
    alias: string,
  ): Promise<void> {
    await this.request(
      credentials,
      `/aliases/${encodeURIComponent(alias)}`,
      { method: 'DELETE' },
      true,
    );
  }

  async importDocuments(
    credentials: TypesenseCredentials,
    collectionName: string,
    documents: Array<Record<string, unknown>>,
  ): Promise<ImportResult> {
    const response = await this.rawRequest(
      credentials,
      `/collections/${encodeURIComponent(collectionName)}/documents/import?action=upsert`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: documents.map((document) => JSON.stringify(document)).join('\n'),
      },
    );
    const lines = response.trim().split('\n').filter(Boolean);
    let succeeded = 0;
    let failed = 0;
    for (const line of lines) {
      let result: { success?: boolean };
      try {
        result = JSON.parse(line) as { success?: boolean };
      } catch {
        failed += 1;
        continue;
      }
      if (result.success === true) succeeded += 1;
      else failed += 1;
    }
    if (lines.length !== documents.length) {
      failed += Math.abs(documents.length - lines.length);
    }
    return { succeeded, failed };
  }

  async search(
    credentials: TypesenseCredentials,
    alias: string,
    parameters: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    return this.request(
      credentials,
      `/collections/${encodeURIComponent(alias)}/documents/search?${parameters.toString()}`,
    );
  }

  private async request<T = unknown>(
    credentials: TypesenseCredentials,
    path: string,
    init: RequestInit = {},
    ignoreNotFound = false,
  ): Promise<T> {
    const text = await this.rawRequest(credentials, path, init, ignoreNotFound);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadGatewayException('Typesense returned an invalid response');
    }
  }

  private async rawRequest(
    credentials: TypesenseCredentials,
    path: string,
    init: RequestInit = {},
    ignoreNotFound = false,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(new URL(path, `${credentials.endpoint}/`), {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-typesense-api-key': credentials.apiKey,
          ...init.headers,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.TYPESENSE_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException('Typesense request could not be completed');
    }
    if (ignoreNotFound && response.status === 404) return '';
    if (!response.ok) {
      throw new BadGatewayException(
        `Typesense request failed (${response.status})`,
      );
    }
    return response.text();
  }
}
