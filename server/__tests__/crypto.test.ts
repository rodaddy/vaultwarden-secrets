/**
 * Tests for cryptographic utilities
 */

import { describe, test, expect } from 'bun:test';
import {
  generateKeyPair,
  deriveSharedSecret,
  encryptResponse,
  decryptResponse,
  exportPublicKey,
  importPublicKey,
  base64Encode,
  base64Decode,
} from '../utils/crypto';

describe('Crypto utilities', () => {
  describe('Key generation', () => {
    test('generateKeyPair creates valid ECDH P-256 keypair', async () => {
      const keyPair = await generateKeyPair();

      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey.type).toBe('public');
      expect(keyPair.privateKey.type).toBe('private');
    });

    test('each call generates unique keypairs', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();

      const pubKey1 = await exportPublicKey(keyPair1.publicKey);
      const pubKey2 = await exportPublicKey(keyPair2.publicKey);

      expect(pubKey1).not.toEqual(pubKey2);
    });
  });

  describe('Key exchange (ECDH)', () => {
    test('derives same shared secret for both parties', async () => {
      // Alice generates keypair
      const aliceKeyPair = await generateKeyPair();

      // Bob generates keypair
      const bobKeyPair = await generateKeyPair();

      // Alice derives shared secret using her private key + Bob's public key
      const aliceShared = await deriveSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Bob derives shared secret using his private key + Alice's public key
      const bobShared = await deriveSharedSecret(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey
      );

      // Export to compare (need to encrypt/decrypt to verify they're the same)
      const testData = 'test data';
      const encrypted = await encryptResponse(testData, aliceShared);
      const decrypted = await decryptResponse(
        encrypted.ciphertext,
        encrypted.nonce,
        bobShared
      );

      expect(decrypted).toBe(testData);
    });

    test('different keypairs produce different shared secrets', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();
      const keyPair3 = await generateKeyPair();

      const shared1 = await deriveSharedSecret(keyPair1.privateKey, keyPair2.publicKey);
      const shared2 = await deriveSharedSecret(keyPair1.privateKey, keyPair3.publicKey);

      // Test that they're different by attempting to decrypt with wrong key
      const testData = 'test';
      const encrypted = await encryptResponse(testData, shared1);

      await expect(
        decryptResponse(encrypted.ciphertext, encrypted.nonce, shared2)
      ).rejects.toThrow();
    });
  });

  describe('Encryption/Decryption', () => {
    test('encrypt and decrypt round-trip works', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const original = 'Hello, World!';
      const encrypted = await encryptResponse(original, sharedSecret);
      const decrypted = await decryptResponse(
        encrypted.ciphertext,
        encrypted.nonce,
        sharedSecret
      );

      expect(decrypted).toBe(original);
    });

    test('encrypts JSON data correctly', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const original = JSON.stringify({ value: 'secret-password-123' });
      const encrypted = await encryptResponse(original, sharedSecret);
      const decrypted = await decryptResponse(
        encrypted.ciphertext,
        encrypted.nonce,
        sharedSecret
      );

      expect(decrypted).toBe(original);
      expect(JSON.parse(decrypted)).toEqual({ value: 'secret-password-123' });
    });

    test('generates unique nonces for each encryption', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const data = 'test data';
      const encrypted1 = await encryptResponse(data, sharedSecret);
      const encrypted2 = await encryptResponse(data, sharedSecret);

      expect(encrypted1.nonce).not.toEqual(encrypted2.nonce);
      expect(encrypted1.ciphertext).not.toEqual(encrypted2.ciphertext);
    });

    test('ciphertext differs from plaintext', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const plaintext = 'sensitive data';
      const encrypted = await encryptResponse(plaintext, sharedSecret);

      // Ciphertext should not contain the plaintext
      const ciphertextString = new TextDecoder().decode(encrypted.ciphertext);
      expect(ciphertextString).not.toContain('sensitive');
      expect(ciphertextString).not.toContain('data');
    });

    test('wrong nonce fails decryption', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const encrypted = await encryptResponse('test', sharedSecret);
      const wrongNonce = crypto.getRandomValues(new Uint8Array(12));

      await expect(
        decryptResponse(encrypted.ciphertext, wrongNonce, sharedSecret)
      ).rejects.toThrow();
    });

    test('wrong key fails decryption', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();

      const secret1 = await deriveSharedSecret(keyPair1.privateKey, keyPair1.publicKey);
      const secret2 = await deriveSharedSecret(keyPair2.privateKey, keyPair2.publicKey);

      const encrypted = await encryptResponse('test', secret1);

      await expect(
        decryptResponse(encrypted.ciphertext, encrypted.nonce, secret2)
      ).rejects.toThrow();
    });

    test('tampered ciphertext fails decryption', async () => {
      const keyPair = await generateKeyPair();
      const sharedSecret = await deriveSharedSecret(keyPair.privateKey, keyPair.publicKey);

      const encrypted = await encryptResponse('test', sharedSecret);

      // Tamper with ciphertext
      const tampered = new Uint8Array(encrypted.ciphertext);
      tampered[0] ^= 0xff;

      await expect(
        decryptResponse(tampered, encrypted.nonce, sharedSecret)
      ).rejects.toThrow();
    });
  });

  describe('Key import/export', () => {
    test('export and import public key preserves key', async () => {
      const keyPair = await generateKeyPair();

      const exported = await exportPublicKey(keyPair.publicKey);
      expect(exported).toBeInstanceOf(Uint8Array);
      expect(exported.length).toBe(65); // P-256 uncompressed public keys are 65 bytes

      const imported = await importPublicKey(exported);

      // Verify by deriving shared secret with both
      const otherKeyPair = await generateKeyPair();

      const secret1 = await deriveSharedSecret(otherKeyPair.privateKey, keyPair.publicKey);
      const secret2 = await deriveSharedSecret(otherKeyPair.privateKey, imported);

      // Test they produce same result
      const testData = 'test';
      const encrypted = await encryptResponse(testData, secret1);
      const decrypted = await decryptResponse(encrypted.ciphertext, encrypted.nonce, secret2);

      expect(decrypted).toBe(testData);
    });
  });

  describe('Base64 encoding', () => {
    test('base64 encode and decode round-trip', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
      const encoded = base64Encode(original);
      const decoded = base64Decode(encoded);

      expect(decoded).toEqual(original);
    });

    test('base64 encode produces valid base64 string', () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const encoded = base64Encode(bytes);

      // Valid base64 characters
      expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('End-to-end encryption flow', () => {
    test('simulates client-server encryption flow', async () => {
      // Client generates keypair
      const clientKeyPair = await generateKeyPair();
      const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
      const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);

      // Client sends public key to server via header (simulated)
      // Server receives client public key
      const receivedClientPubKeyBytes = base64Decode(clientPublicKeyBase64);
      const receivedClientPubKey = await importPublicKey(receivedClientPubKeyBytes);

      // Server generates ephemeral keypair
      const serverKeyPair = await generateKeyPair();

      // Server derives shared secret
      const serverSharedSecret = await deriveSharedSecret(
        serverKeyPair.privateKey,
        receivedClientPubKey
      );

      // Server encrypts response
      const responseData = JSON.stringify({ value: 'super-secret-password' });
      const encrypted = await encryptResponse(responseData, serverSharedSecret);

      // Server sends back: public key, nonce, ciphertext (as base64)
      const serverPublicKeyBytes = await exportPublicKey(serverKeyPair.publicKey);
      const serverPublicKeyBase64 = base64Encode(serverPublicKeyBytes);
      const nonceBase64 = base64Encode(encrypted.nonce);
      const ciphertextBase64 = base64Encode(encrypted.ciphertext);

      // Client receives server public key
      const receivedServerPubKeyBytes = base64Decode(serverPublicKeyBase64);
      const receivedServerPubKey = await importPublicKey(receivedServerPubKeyBytes);

      // Client derives same shared secret
      const clientSharedSecret = await deriveSharedSecret(
        clientKeyPair.privateKey,
        receivedServerPubKey
      );

      // Client decrypts response
      const receivedNonce = base64Decode(nonceBase64);
      const receivedCiphertext = base64Decode(ciphertextBase64);

      const decrypted = await decryptResponse(
        receivedCiphertext,
        receivedNonce,
        clientSharedSecret
      );

      expect(decrypted).toBe(responseData);
      expect(JSON.parse(decrypted)).toEqual({ value: 'super-secret-password' });
    });
  });
});
