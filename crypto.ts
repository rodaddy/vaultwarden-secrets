import * as crypto from 'node:crypto';
import { EncryptedData, SecretError, ErrorCode, Constants } from './types';

/**
 * Derive encryption key from password using PBKDF2
 * @param password - Password or master key bytes
 * @param salt - 32-byte salt
 * @returns 32-byte derived key
 */
export async function deriveKey(
  password: string | Buffer,
  salt: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      Constants.PBKDF2_ITERATIONS,
      32,
      'sha256',
      (err, key) => {
        if (err) {
          reject(
            new SecretError('Key derivation failed', ErrorCode.ENCRYPTION_FAILED)
          );
        } else {
          resolve(key);
        }
      }
    );
  });
}

/**
 * Encrypt data using AES-256-GCM
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 * @returns Encrypted data structure
 */
export async function encrypt(
  plaintext: string,
  key: Buffer
): Promise<EncryptedData> {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encryptedData: encrypted.toString('base64'),
    };
  } catch (error) {
    throw new SecretError(
      `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ErrorCode.ENCRYPTION_FAILED
    );
  }
}

/**
 * Decrypt data using AES-256-GCM
 * @param encrypted - Encrypted data structure
 * @param key - 32-byte encryption key
 * @returns Decrypted plaintext
 */
export async function decrypt(
  encrypted: EncryptedData,
  key: Buffer
): Promise<string> {
  try {
    const iv = Buffer.from(encrypted.iv, 'base64');
    const authTag = Buffer.from(encrypted.authTag, 'base64');
    const ciphertext = Buffer.from(encrypted.encryptedData, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    throw new SecretError(
      `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ErrorCode.DECRYPTION_FAILED
    );
  }
}

/**
 * Generate a random 32-byte master key
 */
export function generateMasterKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Compute HMAC-SHA256 for cache integrity
 */
export function computeHmac(data: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(data).digest('base64');
}

/**
 * Verify HMAC-SHA256
 */
export function verifyHmac(
  data: string,
  key: Buffer,
  expectedHmac: string
): boolean {
  try {
    const computed = computeHmac(data, key);
    return crypto.timingSafeEqual(
      Buffer.from(computed, 'base64'),
      Buffer.from(expectedHmac, 'base64')
    );
  } catch (error) {
    // timingSafeEqual throws if buffers have different lengths
    return false;
  }
}
