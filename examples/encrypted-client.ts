#!/usr/bin/env bun
/**
 * Example client demonstrating response encryption
 *
 * This shows how to:
 * 1. Generate client keypair
 * 2. Send public key to server
 * 3. Receive encrypted response
 * 4. Decrypt response using shared secret
 *
 * Usage:
 *   bun examples/encrypted-client.ts [secret-name]
 */

import {
  generateKeyPair,
  deriveSharedSecret,
  decryptResponse,
  exportPublicKey,
  importPublicKey,
  base64Encode,
  base64Decode,
} from '../server/utils/crypto';

async function getEncryptedSecret(secretName: string, serverUrl: string, apiToken?: string) {
  // 1. Generate client keypair
  console.log('Generating client keypair...');
  const clientKeyPair = await generateKeyPair();
  const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
  const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);

  // 2. Make request with client public key in header
  console.log('Requesting secret from server...');
  const headers: Record<string, string> = {
    'X-Client-Public-Key': clientPublicKeyBase64,
  };

  if (apiToken) {
    headers['Authorization'] = `Bearer ${apiToken}`;
  }

  const response = await fetch(`${serverUrl}/secret/${encodeURIComponent(secretName)}`, {
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Server error: ${error.error || response.statusText}`);
  }

  // 3. Extract encryption metadata from headers
  const serverPublicKeyBase64 = response.headers.get('X-Server-Public-Key');
  const nonceBase64 = response.headers.get('X-Encryption-Nonce');

  if (!serverPublicKeyBase64 || !nonceBase64) {
    throw new Error('Response missing encryption headers');
  }

  // 4. Get encrypted response body
  const ciphertextBase64 = await response.text();

  // 5. Import server public key
  console.log('Decrypting response...');
  const serverPublicKeyBytes = base64Decode(serverPublicKeyBase64);
  const serverPublicKey = await importPublicKey(serverPublicKeyBytes);

  // 6. Derive shared secret using client private key + server public key
  const sharedSecret = await deriveSharedSecret(clientKeyPair.privateKey, serverPublicKey);

  // 7. Decrypt response
  const nonce = base64Decode(nonceBase64);
  const ciphertext = base64Decode(ciphertextBase64);
  const decrypted = await decryptResponse(ciphertext, nonce, sharedSecret);

  // 8. Parse JSON response
  const result = JSON.parse(decrypted);
  return result;
}

// Main
const secretName = process.argv[2] || 'test-secret';
const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
const apiToken = process.env.API_TOKEN;

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Encrypted Secret Retrieval Example');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Secret:      ${secretName}`);
console.log(`Server URL:  ${serverUrl}`);
console.log(`API Token:   ${apiToken ? '✓ configured' : '✗ not set'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

try {
  const result = await getEncryptedSecret(secretName, serverUrl, apiToken);
  console.log('');
  console.log('✓ Successfully retrieved and decrypted secret:');
  console.log('');
  console.log(JSON.stringify(result, null, 2));
  console.log('');
} catch (error) {
  console.error('');
  console.error('✗ Failed to retrieve secret:');
  console.error('');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  process.exit(1);
}
