import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { roleAllows } from '../src/workspaces/access.js';

describe('authentication security', () => {
  it('hashes passwords with Argon2id and verifies only the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(
      verifyPassword(hash, 'correct horse battery staple'),
    ).resolves.toBe(true);
    await expect(verifyPassword(hash, 'incorrect-password')).resolves.toBe(
      false,
    );
  });
});

describe('workspace role policy', () => {
  it('allows owner and admin administration but rejects lower roles', () => {
    expect(roleAllows('OWNER', 'ADMIN')).toBe(true);
    expect(roleAllows('ADMIN', 'ADMIN')).toBe(true);
    expect(roleAllows('EDITOR', 'ADMIN')).toBe(false);
    expect(roleAllows('VIEWER', 'ADMIN')).toBe(false);
  });

  it('allows editors to change project content without granting administration', () => {
    expect(roleAllows('OWNER', 'EDITOR')).toBe(true);
    expect(roleAllows('ADMIN', 'EDITOR')).toBe(true);
    expect(roleAllows('EDITOR', 'EDITOR')).toBe(true);
    expect(roleAllows('VIEWER', 'EDITOR')).toBe(false);
  });

  it('allows every workspace member to read', () => {
    expect(roleAllows('OWNER', 'VIEWER')).toBe(true);
    expect(roleAllows('ADMIN', 'VIEWER')).toBe(true);
    expect(roleAllows('EDITOR', 'VIEWER')).toBe(true);
    expect(roleAllows('VIEWER', 'VIEWER')).toBe(true);
  });
});
