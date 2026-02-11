/**
 * Tests for response encryption middleware
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { responseEncryption } from '../middleware/response-encryption';
import type { SecurityProfile } from '../profiles';
import {
  generateKeyPair,
  deriveSharedSecret,
  decryptResponse,
  exportPublicKey,
  importPublicKey,
  base64Encode,
  base64Decode,
} from '../utils/crypto';

describe('Response encryption middleware', () => {
  const createTestApp = (profile: Partial<SecurityProfile>) => {
    const app = new Hono();
    const fullProfile = {
      name: 'test',
      description: 'test profile',
      auth: false,
      ipWhitelist: false,
      tls: false,
      audit: 'none',
      rateLimit: false,
      ...profile,
    } as SecurityProfile;

    app.use('*', responseEncryption(fullProfile));

    // Test endpoint
    app.get('/secret/:name', (c) => {
      return c.json({ value: 'test-secret-value' });
    });

    // Other endpoint (should not be encrypted)
    app.get('/health', (c) => {
      return c.json({ status: 'ok' });
    });

    return app;
  };

  describe('Profile without encryption', () => {
    test('passes through requests without encryption', async () => {
      const app = createTestApp({ secretsEncrypted: false });

      const res = await app.request('/secret/test');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ value: 'test-secret-value' });

      // Should not have encryption headers
      expect(res.headers.get('X-Server-Public-Key')).toBeNull();
      expect(res.headers.get('X-Encryption-Nonce')).toBeNull();
    });
  });

  describe('Profile with encryption', () => {
    test('requires X-Client-Public-Key header', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      const res = await app.request('/secret/test');
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Encryption required');
    });

    test('does not encrypt non-secret endpoints', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });

      // Should not have encryption headers
      expect(res.headers.get('X-Server-Public-Key')).toBeNull();
    });

    test('encrypts response when client public key provided', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // Generate client keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
      const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);

      // Make request with client public key
      const res = await app.request('/secret/test', {
        headers: {
          'X-Client-Public-Key': clientPublicKeyBase64,
        },
      });

      expect(res.status).toBe(200);

      // Should have encryption headers
      const serverPublicKey = res.headers.get('X-Server-Public-Key');
      const nonce = res.headers.get('X-Encryption-Nonce');
      expect(serverPublicKey).toBeTruthy();
      expect(nonce).toBeTruthy();

      // Content type should be octet-stream
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');

      // Body should be base64 encoded ciphertext
      const encryptedBody = await res.text();
      expect(encryptedBody).toBeTruthy();
      expect(encryptedBody).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test('encrypted response can be decrypted by client', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // Generate client keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
      const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);

      // Make request
      const res = await app.request('/secret/test', {
        headers: {
          'X-Client-Public-Key': clientPublicKeyBase64,
        },
      });

      expect(res.status).toBe(200);

      // Get encryption metadata
      const serverPublicKeyBase64 = res.headers.get('X-Server-Public-Key')!;
      const nonceBase64 = res.headers.get('X-Encryption-Nonce')!;
      const ciphertextBase64 = await res.text();

      // Import server public key
      const serverPublicKeyBytes = base64Decode(serverPublicKeyBase64);
      const serverPublicKey = await importPublicKey(serverPublicKeyBytes);

      // Derive shared secret (client side)
      const sharedSecret = await deriveSharedSecret(clientKeyPair.privateKey, serverPublicKey);

      // Decrypt
      const nonce = base64Decode(nonceBase64);
      const ciphertext = base64Decode(ciphertextBase64);
      const decrypted = await decryptResponse(ciphertext, nonce, sharedSecret);

      // Verify decrypted data
      const decryptedJson = JSON.parse(decrypted);
      expect(decryptedJson).toEqual({ value: 'test-secret-value' });
    });

    test('each request uses unique ephemeral keys', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // Generate client keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBase64 = base64Encode(
        await exportPublicKey(clientKeyPair.publicKey)
      );

      // Make two requests
      const res1 = await app.request('/secret/test1', {
        headers: { 'X-Client-Public-Key': clientPublicKeyBase64 },
      });

      const res2 = await app.request('/secret/test2', {
        headers: { 'X-Client-Public-Key': clientPublicKeyBase64 },
      });

      // Server public keys should be different (ephemeral)
      const serverPubKey1 = res1.headers.get('X-Server-Public-Key');
      const serverPubKey2 = res2.headers.get('X-Server-Public-Key');
      expect(serverPubKey1).not.toBe(serverPubKey2);

      // Nonces should be different
      const nonce1 = res1.headers.get('X-Encryption-Nonce');
      const nonce2 = res2.headers.get('X-Encryption-Nonce');
      expect(nonce1).not.toBe(nonce2);
    });

    test('invalid client public key returns error', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // Send invalid base64
      const res = await app.request('/secret/test', {
        headers: {
          'X-Client-Public-Key': 'invalid-base64!!!',
        },
      });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Invalid client public key');
    });

    test('does not encrypt error responses', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // Generate client keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBase64 = base64Encode(
        await exportPublicKey(clientKeyPair.publicKey)
      );

      // Create app that returns error
      const errorApp = new Hono();
      errorApp.use('*', responseEncryption({
        name: 'test',
        description: 'test',
        auth: false,
        ipWhitelist: false,
        tls: false,
        audit: 'none',
        rateLimit: false,
        secretsEncrypted: true,
      } as SecurityProfile));

      errorApp.get('/secret/:name', (c) => {
        return c.json({ error: 'Secret not found' }, 404);
      });

      const res = await errorApp.request('/secret/nonexistent', {
        headers: {
          'X-Client-Public-Key': clientPublicKeyBase64,
        },
      });

      expect(res.status).toBe(404);

      // Should not be encrypted
      expect(res.headers.get('X-Server-Public-Key')).toBeNull();
      expect(res.headers.get('Content-Type')).not.toBe('application/octet-stream');

      const body = await res.json();
      expect(body).toEqual({ error: 'Secret not found' });
    });
  });

  describe('Full encryption flow', () => {
    test('complete client-server encryption scenario', async () => {
      const app = createTestApp({ secretsEncrypted: true });

      // 1. Client generates keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
      const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);

      // 2. Client makes request with public key in header
      const res = await app.request('/secret/my-password', {
        headers: {
          'X-Client-Public-Key': clientPublicKeyBase64,
        },
      });

      // 3. Verify response
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Server-Public-Key')).toBeTruthy();
      expect(res.headers.get('X-Encryption-Nonce')).toBeTruthy();
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');

      // 4. Client extracts encryption metadata
      const serverPublicKeyBase64 = res.headers.get('X-Server-Public-Key')!;
      const nonceBase64 = res.headers.get('X-Encryption-Nonce')!;
      const ciphertextBase64 = await res.text();

      // 5. Client imports server public key
      const serverPublicKeyBytes = base64Decode(serverPublicKeyBase64);
      const serverPublicKey = await importPublicKey(serverPublicKeyBytes);

      // 6. Client derives shared secret
      const sharedSecret = await deriveSharedSecret(
        clientKeyPair.privateKey,
        serverPublicKey
      );

      // 7. Client decrypts response
      const nonce = base64Decode(nonceBase64);
      const ciphertext = base64Decode(ciphertextBase64);
      const decrypted = await decryptResponse(ciphertext, nonce, sharedSecret);

      // 8. Client parses decrypted JSON
      const secret = JSON.parse(decrypted);
      expect(secret).toEqual({ value: 'test-secret-value' });
    });
  });
});
