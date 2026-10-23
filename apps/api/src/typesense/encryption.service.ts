import { Inject, Injectable } from '@nestjs/common';
import { decryptEnvelope, encryptEnvelope } from '@osc/ingestion';

import { APP_CONFIG, type AppConfig } from '../app-config.js';

@Injectable()
export class EncryptionService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  encrypt(plaintext: string): string {
    return this.encryptFor('typesense-api-key', plaintext);
  }

  encryptFor(purpose: string, plaintext: string): string {
    return encryptEnvelope(purpose, plaintext, this.config.APP_ENCRYPTION_KEY);
  }

  decrypt(envelope: string): string {
    return this.decryptFor('typesense-api-key', envelope);
  }

  decryptFor(purpose: string, envelope: string): string {
    return decryptEnvelope(
      purpose,
      envelope,
      this.config.APP_ENCRYPTION_KEY,
      this.config.APP_ENCRYPTION_KEY_PREVIOUS,
    ).toString('utf8');
  }
}
