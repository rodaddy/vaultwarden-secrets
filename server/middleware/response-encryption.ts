/**
 * Response encryption middleware
 * Encrypts response bodies for profiles with secretsEncrypted: true
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { SecurityProfile } from '../profiles';
import {
  generateKeyPair,
  deriveSharedSecret,
  encryptResponse,
  exportPublicKey,
  importPublicKey,
  base64Encode,
  base64Decode,
} from '../utils/crypto';

/**
 * Create response encryption middleware
 */
export function responseEncryption(profile: SecurityProfile): MiddlewareHandler {
  return async (c: Context, next) => {
    // Only encrypt if profile requires it
    if (!profile.secretsEncrypted) {
      return await next();
    }

    // Only encrypt /secret/:name endpoint
    const path = c.req.path;
    if (!path.startsWith('/secret/')) {
      return await next();
    }

    // Check for client public key
    const clientPublicKeyHeader = c.req.header('X-Client-Public-Key');
    if (!clientPublicKeyHeader) {
      return c.json(
        {
          error: 'Encryption required',
          message: 'X-Client-Public-Key header is required for this profile',
        },
        400
      );
    }

    // Validate client public key early
    let clientPublicKey: CryptoKey;
    try {
      const clientPublicKeyBytes = base64Decode(clientPublicKeyHeader);
      clientPublicKey = await importPublicKey(clientPublicKeyBytes);
    } catch (error) {
      return c.json(
        {
          error: 'Invalid client public key',
          message: error instanceof Error ? error.message : 'Invalid key format',
        },
        400
      );
    }

    // Continue with request processing
    await next();

    // Only encrypt successful responses
    if (c.res.status !== 200) {
      return;
    }

    try {
      // Clone response before reading to avoid locking the stream
      const clonedRes = c.res.clone();
      const responseBody = await clonedRes.text();

      // Generate server ephemeral keypair
      const serverKeyPair = await generateKeyPair();

      // Derive shared secret
      const sharedSecret = await deriveSharedSecret(
        serverKeyPair.privateKey,
        clientPublicKey
      );

      // Encrypt response
      const { ciphertext, nonce } = await encryptResponse(responseBody, sharedSecret);

      // Export server public key
      const serverPublicKeyBytes = await exportPublicKey(serverKeyPair.publicKey);

      // Create new response with encrypted data
      const encryptedBody = base64Encode(ciphertext);

      // Build new response with encryption headers
      c.res = new Response(encryptedBody, {
        status: 200,
        headers: {
          'X-Server-Public-Key': base64Encode(serverPublicKeyBytes),
          'X-Encryption-Nonce': base64Encode(nonce),
          'Content-Type': 'application/octet-stream',
        },
      });
    } catch (error) {
      c.res = Response.json(
        {
          error: 'Encryption failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        { status: 500 }
      );
    }
  };
}
