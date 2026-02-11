import { describe, test, expect } from 'bun:test';
import { buildCreateTemplate, mergeUpdateFields } from '../vault-client';

// ---------------------------------------------------------------------------
// buildCreateTemplate
// ---------------------------------------------------------------------------

describe('buildCreateTemplate', () => {
  const folderId = 'folder-123';

  test('login item with all fields', () => {
    const result = buildCreateTemplate({
      name: 'My Service',
      folderId,
      username: 'test-user',
      password: 'test-pass',
      uri: 'https://example.com',
      notes: 'Test creds',
    });

    expect(result.type).toBe(1);
    expect(result.name).toBe('My Service');
    expect(result.folderId).toBe(folderId);
    expect(result.notes).toBe('Test creds');
    expect(result.login).toEqual({
      username: 'test-user',
      password: 'test-pass',
      uris: [{ match: null, uri: 'https://example.com' }],
    });
    expect(result.fields).toBeUndefined();
    expect(result.secureNote).toBeUndefined();
  });

  test('login item with custom fields', () => {
    const result = buildCreateTemplate({
      name: 'API Key',
      folderId,
      fields: [
        { name: 'api_key', value: 'abc-123' },
        { name: 'secret', value: 'xyz', type: 1 },
      ],
    });

    expect(result.type).toBe(1);
    expect(result.login).toBeDefined();
    expect(result.fields).toEqual([
      { name: 'api_key', value: 'abc-123', type: 0 },
      { name: 'secret', value: 'xyz', type: 1 },
    ]);
  });

  test('secure note (type 2) omits login block', () => {
    const result = buildCreateTemplate({
      name: 'Note Item',
      type: 2,
      folderId,
      notes: 'Some notes',
    });

    expect(result.type).toBe(2);
    expect(result.login).toBeUndefined();
    expect(result.secureNote).toEqual({ type: 0 });
    expect(result.notes).toBe('Some notes');
  });

  test('secure note with custom fields — PROXMOX_API pattern', () => {
    const result = buildCreateTemplate({
      name: 'PROXMOX_API',
      type: 2,
      folderId,
      notes: 'API credentials for Proxmox cluster',
      fields: [
        { name: 'Token ID', value: 'claude@pve!mcp' },
        { name: 'Token value', value: 'super-secret-token', type: 1 },
      ],
    });

    expect(result.type).toBe(2);
    expect(result.login).toBeUndefined();
    expect(result.secureNote).toEqual({ type: 0 });
    expect(result.fields).toEqual([
      { name: 'Token ID', value: 'claude@pve!mcp', type: 0 },
      { name: 'Token value', value: 'super-secret-token', type: 1 },
    ]);
  });

  test('defaults type to 1', () => {
    const result = buildCreateTemplate({ name: 'Test', folderId });
    expect(result.type).toBe(1);
    expect(result.login).toBeDefined();
  });

  test('custom field type defaults to 0 (text)', () => {
    const result = buildCreateTemplate({
      name: 'Test',
      folderId,
      fields: [{ name: 'key', value: 'val' }],
    });
    expect(result.fields).toEqual([{ name: 'key', value: 'val', type: 0 }]);
  });

  test('empty fields array is omitted', () => {
    const result = buildCreateTemplate({
      name: 'Test',
      folderId,
      fields: [],
    });
    expect(result.fields).toBeUndefined();
  });

  test('missing optional login fields default to null', () => {
    const result = buildCreateTemplate({ name: 'Bare', folderId });
    expect((result.login as any).username).toBeNull();
    expect((result.login as any).password).toBeNull();
    expect((result.login as any).uris).toEqual([]);
    expect(result.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeUpdateFields
// ---------------------------------------------------------------------------

describe('mergeUpdateFields', () => {
  function makeLoginItem(overrides: Record<string, any> = {}): Record<string, any> {
    return {
      id: 'item-001',
      type: 1,
      name: 'Existing',
      login: {
        username: 'old-user',
        password: 'old-pass',
        uris: [{ match: null, uri: 'https://old.com' }],
      },
      notes: 'old notes',
      fields: [
        { name: 'env', value: 'prod', type: 0 },
        { name: 'region', value: 'us-east', type: 0 },
      ],
      ...overrides,
    };
  }

  test('merge strategy: updates existing field by name, preserves others', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, {
      fields: [{ name: 'env', value: 'staging' }],
    });

    expect(result.fields).toEqual([
      { name: 'env', value: 'staging', type: 0 },
      { name: 'region', value: 'us-east', type: 0 },
    ]);
  });

  test('merge strategy: appends new fields', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, {
      fields: [{ name: 'tier', value: 'premium', type: 1 }],
    });

    expect(result.fields).toHaveLength(3);
    expect(result.fields[2]).toEqual({ name: 'tier', value: 'premium', type: 1 });
  });

  test('replace strategy: replaces all fields', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, {
      fields: [{ name: 'only-field', value: 'val' }],
      fieldStrategy: 'replace',
    });

    expect(result.fields).toEqual([
      { name: 'only-field', value: 'val', type: 0 },
    ]);
  });

  test('defaults to merge strategy', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, {
      fields: [{ name: 'env', value: 'dev' }],
      // fieldStrategy omitted
    });

    // Should merge (update existing), not replace
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].value).toBe('dev');
  });

  test('updates login fields independently', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, { username: 'new-user' });

    expect(result.login.username).toBe('new-user');
    expect(result.login.password).toBe('old-pass');
    expect(result.login.uris).toEqual([{ match: null, uri: 'https://old.com' }]);
  });

  test('URI update replaces entire uris array', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, { uri: 'https://new.com' });

    expect(result.login.uris).toEqual([{ match: null, uri: 'https://new.com' }]);
    expect(result.login.username).toBe('old-user');
  });

  test('handles item with no existing fields', () => {
    const item = makeLoginItem({ fields: undefined });
    const result = mergeUpdateFields(item, {
      fields: [{ name: 'new-field', value: 'val' }],
    });

    expect(result.fields).toEqual([{ name: 'new-field', value: 'val', type: 0 }]);
  });

  test('adding custom fields to Secure Note — PROXMOX_API pattern', () => {
    const secureNote = {
      id: 'item-proxmox',
      type: 2,
      name: 'PROXMOX_API',
      secureNote: { type: 0 },
      notes: 'API creds',
      // No fields yet
    };

    const result = mergeUpdateFields(secureNote, {
      fields: [
        { name: 'Token ID', value: 'claude@pve!mcp' },
        { name: 'Token value', value: 'secret-token', type: 1 },
      ],
    });

    expect(result.fields).toEqual([
      { name: 'Token ID', value: 'claude@pve!mcp', type: 0 },
      { name: 'Token value', value: 'secret-token', type: 1 },
    ]);
    // Original item untouched
    expect(secureNote).not.toHaveProperty('fields');
  });

  test('does not mutate the original item', () => {
    const item = makeLoginItem();
    const originalPassword = item.login.password;
    mergeUpdateFields(item, { password: 'changed' });

    expect(item.login.password).toBe(originalPassword);
  });

  test('notes update only affects notes', () => {
    const item = makeLoginItem();
    const result = mergeUpdateFields(item, { notes: 'new notes' });

    expect(result.notes).toBe('new notes');
    expect(result.login.username).toBe('old-user');
    expect(result.fields).toEqual(item.fields);
  });
});
