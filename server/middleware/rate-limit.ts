/**
 * Rate limiting middleware
 * Sliding window rate limiter with per-client tracking
 */

import type { Context, Next } from 'hono';
import type { RateLimitConfig } from '../profiles';
import { getClientIP } from '../utils/network';

interface RateLimitState {
  requests: number[];
  blocked: boolean;
  blockedUntil?: number;
}

/**
 * Parse window string to milliseconds
 * Examples: "1m" → 60000, "1h" → 3600000
 */
function parseWindow(window: string): number {
  const match = window.match(/^(\d+)([smh])$/);
  if (!match) throw new Error(`Invalid window format: ${window}`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid window unit: ${unit}`);
  }
}

/**
 * Rate limit middleware factory
 */
export function rateLimit(config: RateLimitConfig) {
  const windowMs = parseWindow(config.window);
  const maxRequests = config.requests;
  const burst = config.burst || 0;

  // In-memory state: clientId → RateLimitState
  const clients = new Map<string, RateLimitState>();

  return async (c: Context, next: Next) => {
    // Identify client (by ID from auth, or IP)
    const clientId = c.get('clientId') || getClientIP(c) || 'unknown';

    const now = Date.now();
    let state = clients.get(clientId);

    if (!state) {
      state = { requests: [], blocked: false };
      clients.set(clientId, state);
    }

    // Check if client is temporarily blocked
    if (state.blocked && state.blockedUntil) {
      if (now < state.blockedUntil) {
        const retryAfter = Math.ceil((state.blockedUntil - now) / 1000);
        return c.json(
          {
            error: 'Rate limit exceeded',
            message: 'Too many requests',
            retryAfter,
          },
          429,
          {
            'Retry-After': retryAfter.toString(),
          }
        );
      } else {
        // Unblock
        state.blocked = false;
        state.blockedUntil = undefined;
      }
    }

    // Clean old requests outside window
    state.requests = state.requests.filter((timestamp) => now - timestamp < windowMs);

    // Check if over limit
    if (state.requests.length >= maxRequests + burst) {
      // Block for window duration
      state.blocked = true;
      state.blockedUntil = now + windowMs;

      console.warn(
        `Rate limit exceeded for client: ${clientId} (${state.requests.length} requests in window)`
      );

      const retryAfter = Math.ceil(windowMs / 1000);
      return c.json(
        {
          error: 'Rate limit exceeded',
          message: `Maximum ${maxRequests} requests per ${config.window}`,
          retryAfter,
        },
        429,
        {
          'Retry-After': retryAfter.toString(),
        }
      );
    }

    // Add this request to history
    state.requests.push(now);

    // Add rate limit headers
    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', (maxRequests - state.requests.length).toString());
    c.header('X-RateLimit-Reset', new Date(now + windowMs).toISOString());

    await next();
  };
}
