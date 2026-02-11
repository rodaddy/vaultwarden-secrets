/**
 * JWT utilities for OAuth2 authentication
 * Uses HS256 for token signing/verification
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET || 'default-jwt-secret-change-in-production';
const SECRET_KEY = new TextEncoder().encode(JWT_SECRET);

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // client_id
  scope: string;
  type: 'access';
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string; // client_id
  type: 'refresh';
}

/**
 * Sign an access token
 * @param payload Token payload containing client_id and scope
 * @param expiresIn Expiration time in seconds (default: 900 = 15 min)
 */
export async function signAccessToken(
  payload: { sub: string; scope: string },
  expiresIn: number = 900
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: payload.sub,
    scope: payload.scope,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setIssuer('vaultwarden-secrets')
    .sign(SECRET_KEY);
}

/**
 * Sign a refresh token
 * @param payload Token payload containing client_id
 * @param expiresIn Expiration time in seconds (default: 604800 = 7 days)
 */
export async function signRefreshToken(
  payload: { sub: string },
  expiresIn: number = 604800
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: payload.sub,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setIssuer('vaultwarden-secrets')
    .sign(SECRET_KEY);
}

/**
 * Verify and decode a JWT token
 * @param token JWT token to verify
 * @returns Decoded payload
 * @throws Error if token is invalid or expired
 */
export async function verifyToken(token: string): Promise<AccessTokenPayload | RefreshTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY, {
      issuer: 'vaultwarden-secrets',
    });

    return payload as AccessTokenPayload | RefreshTokenPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Token verification failed: ${error.message}`);
    }
    throw new Error('Token verification failed: Unknown error');
  }
}

/**
 * Check if a token is an access token
 */
export function isAccessToken(payload: AccessTokenPayload | RefreshTokenPayload): payload is AccessTokenPayload {
  return payload.type === 'access';
}

/**
 * Check if a token is a refresh token
 */
export function isRefreshToken(payload: AccessTokenPayload | RefreshTokenPayload): payload is RefreshTokenPayload {
  return payload.type === 'refresh';
}
