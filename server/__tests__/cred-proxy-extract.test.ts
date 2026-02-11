import { describe, test, expect } from 'bun:test';
import { extractFields, autoMapFields } from '../cred-proxy-extract';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const loginItem = {
  type: 1,
  name: 'LiteLLM API Key',
  login: {
    username: 'admin',
    password: 'test-value-abc',
    uris: [{ match: null, uri: 'https://litellm.example.com' }],
  },
  fields: [
    { name: 'Base URL', value: 'http://10.71.20.10:4000/v1', type: 0 },
    { name: 'Token ID', value: 'tok-abc', type: 0 },
  ],
  notes: 'LiteLLM proxy credentials',
};

const secureNoteItem = {
  type: 2,
  name: 'Infrastructure Notes',
  secureNote: { type: 0 },
  fields: [
    { name: 'api key', value: 'secret-456', type: 1 },
    { name: 'Region', value: 'us-east-1', type: 0 },
  ],
  notes: 'Some notes here',
};

const minimalItem = {
  type: 1,
  name: 'Bare Item',
  login: {
    username: null,
    password: null,
    uris: [],
  },
  fields: null,
  notes: null,
};

// ---------------------------------------------------------------------------
// extractFields
// ---------------------------------------------------------------------------

describe('extractFields', () => {
  test('extracts login.password and login.username', () => {
    const result = extractFields(loginItem, {
      OPENAI_API_KEY: 'login.password',
      USER: 'login.username',
    });
    expect(result).toEqual({
      OPENAI_API_KEY: 'test-value-abc',
      USER: 'admin',
    });
  });

  test('extracts login.uri from uris array', () => {
    const result = extractFields(loginItem, { ENDPOINT: 'login.uri' });
    expect(result).toEqual({ ENDPOINT: 'https://litellm.example.com' });
  });

  test('extracts custom field by name', () => {
    const result = extractFields(loginItem, {
      OPENAI_BASE_URL: 'field:Base URL',
      TOKEN: 'field:Token ID',
    });
    expect(result).toEqual({
      OPENAI_BASE_URL: 'http://10.71.20.10:4000/v1',
      TOKEN: 'tok-abc',
    });
  });

  test('returns empty object for missing field paths', () => {
    const result = extractFields(loginItem, {
      MISSING: 'field:Nonexistent',
      ALSO_MISSING: 'login.totp',
    });
    expect(result).toEqual({});
  });

  test('extracts notes', () => {
    const result = extractFields(loginItem, { INFO: 'notes' });
    expect(result).toEqual({ INFO: 'LiteLLM proxy credentials' });
  });

  test('handles secure note item with no login block', () => {
    const result = extractFields(secureNoteItem, {
      KEY: 'field:api key',
      REGION: 'field:Region',
      USER: 'login.username',
    });
    expect(result).toEqual({
      KEY: 'secret-456',
      REGION: 'us-east-1',
    });
  });
});

// ---------------------------------------------------------------------------
// autoMapFields
// ---------------------------------------------------------------------------

describe('autoMapFields', () => {
  test('maps login fields to USERNAME/PASSWORD/URI', () => {
    const result = autoMapFields(loginItem);
    expect(result.USERNAME).toBe('admin');
    expect(result.PASSWORD).toBe('test-value-abc');
    expect(result.URI).toBe('https://litellm.example.com');
  });

  test('maps custom fields with spaces to underscored uppercase', () => {
    const result = autoMapFields(loginItem);
    expect(result.BASE_URL).toBe('http://10.71.20.10:4000/v1');
    expect(result.TOKEN_ID).toBe('tok-abc');
  });

  test('skips null/empty values', () => {
    const result = autoMapFields(minimalItem);
    expect(result).toEqual({});
  });

  test('handles item with only custom fields (no login)', () => {
    const result = autoMapFields(secureNoteItem);
    expect(result.API_KEY).toBe('secret-456');
    expect(result.REGION).toBe('us-east-1');
    expect(result.NOTES).toBe('Some notes here');
    expect(result.USERNAME).toBeUndefined();
  });

  test('includes URI from uris array', () => {
    const result = autoMapFields(loginItem);
    expect(result.URI).toBe('https://litellm.example.com');
  });
});
