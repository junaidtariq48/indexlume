import { describe, expect, it } from 'vitest';

import {
  createMemberRequestSchema,
  createWorkspaceRequestSchema,
  setupOwnerRequestSchema,
} from '../src/index.js';

describe('M1 write contracts', () => {
  it('rejects short passwords and unknown owner setup properties', () => {
    expect(() =>
      setupOwnerRequestSchema.parse({
        email: 'owner@example.com',
        password: 'short',
      }),
    ).toThrow();
    expect(() =>
      setupOwnerRequestSchema.parse({
        email: 'owner@example.com',
        password: 'a-secure-password',
        role: 'OWNER',
      }),
    ).toThrow();
  });

  it('accepts only normalized workspace slugs', () => {
    expect(
      createWorkspaceRequestSchema.parse({ name: 'Main', slug: 'main-space' }),
    ).toEqual({ name: 'Main', slug: 'main-space' });
    expect(() =>
      createWorkspaceRequestSchema.parse({ name: 'Main', slug: 'Main Space' }),
    ).toThrow();
  });

  it('keeps workspace ownership exclusive to the creator', () => {
    expect(() =>
      createMemberRequestSchema.parse({
        email: 'member@example.com',
        password: 'a-secure-password',
        role: 'OWNER',
      }),
    ).toThrow();
  });

  it('accepts editor membership without granting ownership', () => {
    expect(
      createMemberRequestSchema.parse({
        email: 'editor@example.com',
        password: 'a-secure-password',
        role: 'EDITOR',
      }).role,
    ).toBe('EDITOR');
  });
});
