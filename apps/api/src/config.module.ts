import { Global, Module } from '@nestjs/common';
import { apiEnvironmentSchema } from '@osc/contracts';

import { APP_CONFIG } from './app-config.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => apiEnvironmentSchema.parse(process.env),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
