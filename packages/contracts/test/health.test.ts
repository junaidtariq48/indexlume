import { describe, expect, it } from 'vitest';

import { readinessResponseSchema } from '../src/index.js';

describe('readinessResponseSchema', () => {
  it('accepts a complete dependency status', () => {
    expect(
      readinessResponseSchema.parse({
        status: 'ready',
        dependencies: { postgres: true, redis: true, typesense: true },
      }),
    ).toEqual({
      status: 'ready',
      dependencies: { postgres: true, redis: true, typesense: true },
    });
  });

  it('rejects a response that omits a dependency', () => {
    expect(() =>
      readinessResponseSchema.parse({
        status: 'ready',
        dependencies: { postgres: true, redis: true },
      }),
    ).toThrow();
  });
});
