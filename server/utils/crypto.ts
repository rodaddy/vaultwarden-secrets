/**
 * Cryptographic utilities for response encryption
 * Uses ECDH P-256 key exchange + AES-256-GCM for end-to-end encryption
 */

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface EncryptedData {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Generate ephemeral ECDH P-256 keypair
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['deriveBits', 'deriveKey']
  ) as CryptoKeyPair;

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  };
}

/**
 * Derive shared secret using ECDH with P-256
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  // Derive AES-GCM key directly
  const sharedKey = await crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // not extractable for security
    ['encrypt', 'decrypt']
  );

  return sharedKey;
}

/**
 * Encrypt data using AES-256-GCM
 */
export async function encryptResponse(
  data: string,
  sharedSecret: CryptoKey
): Promise<EncryptedData> {
  // Generate random nonce (12 bytes for GCM)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(data);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      tagLength: 128, // 16-byte auth tag
    },
    sharedSecret,
    plaintext as BufferSource
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
  };
}

/**
 * Decrypt data using AES-256-GCM (for testing and client example)
 */
export async function decryptResponse(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  sharedSecret: CryptoKey
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      tagLength: 128,
    },
    sharedSecret,
    ciphertext as BufferSource
  );

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

/**
 * Export public key to raw bytes
 */
export async function exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey('raw', publicKey);
  return new Uint8Array(exported);
}

/**
 * Import public key from raw bytes
 */
export async function importPublicKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    []
  );
}

/**
 * Base64 encode bytes (for headers)
 */
export function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Base64 decode to bytes (from headers)
 */
export function base64Decode(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
