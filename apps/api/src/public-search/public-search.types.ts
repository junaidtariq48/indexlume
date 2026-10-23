import type { Request } from 'express';

export interface PublicSearchContext {
  keyId: string;
  projectId: string;
}

export interface PublicSearchRequestWithContext extends Request {
  publicSearch: PublicSearchContext;
}
