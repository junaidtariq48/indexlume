export interface SearchFilter {
  field: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | number | boolean;
}

export interface SearchSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface SearchRequest {
  q: string;
  filter?: SearchFilter[];
  sort?: SearchSort[];
  facets?: string[];
  page?: number;
  perPage?: number;
}

export interface SearchHit<TDocument> {
  id: string;
  document: TDocument;
  highlights: unknown;
}

export interface SearchResponse<TDocument> {
  hits: Array<SearchHit<TDocument>>;
  found: number;
  page: number;
  perPage: number;
  facets: unknown;
  requestMs: number;
}

export interface SearchClientOptions {
  baseUrl: string;
  projectPublicId: string;
  searchKey: string;
  fetch?: typeof globalThis.fetch;
}

export class SearchClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'SearchClientError';
  }
}

export class SearchClient {
  private readonly baseUrl: string;
  private readonly projectPublicId: string;
  private readonly searchKey: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: SearchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.projectPublicId = options.projectPublicId;
    this.searchKey = options.searchKey;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async search<TDocument = Record<string, unknown>>(
    indexSlug: string,
    input: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResponse<TDocument>> {
    const response = await this.request(
      `${this.baseUrl}/api/v1/search/v1/${encodeURIComponent(this.projectPublicId)}/${encodeURIComponent(indexSlug)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.searchKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal,
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; requestId?: string };
    };
    if (!response.ok) {
      throw new SearchClientError(
        payload.error?.message ?? `Search request failed (${response.status})`,
        response.status,
        payload.error?.requestId,
      );
    }
    return payload as SearchResponse<TDocument>;
  }
}

export const clientPackageVersion = '0.1.0';
