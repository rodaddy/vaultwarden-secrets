/**
 * Network utilities
 */

import type { Context } from 'hono';

/**
 * Get client IP from request
 * Handles X-Forwarded-For, X-Real-IP, and direct connection
 */
export function getClientIP(c: Context): string | null {
  // Check X-Forwarded-For (proxy/load balancer)
  const forwarded = c.req.header('X-Forwarded-For');
  if (forwarded) {
    // Take first IP in chain (original client)
    return forwarded.split(',')[0].trim();
  }

  // Check X-Real-IP (nginx)
  const realIP = c.req.header('X-Real-IP');
  if (realIP) {
    return realIP.trim();
  }

  // No proxy headers - return null (localhost scenario)
  return null;
}
