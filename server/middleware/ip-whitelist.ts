/**
 * IP whitelist middleware
 * Restricts access to specific IP ranges (e.g., internal VLAN)
 */

import type { Context, Next } from 'hono';
import { getClientIP } from '../utils/network';

interface IPRange {
  base: string;
  mask: number;
}

/**
 * Parse CIDR notation into IP range
 */
function parseCIDR(cidr: string): IPRange {
  const [base, maskStr] = cidr.split('/');
  return { base, mask: parseInt(maskStr || '32', 10) };
}

/**
 * Check if IP is in CIDR range
 */
function isIPInRange(ip: string, range: IPRange): boolean {
  const ipParts = ip.split('.').map(Number);
  const baseParts = range.base.split('.').map(Number);

  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const baseNum =
    (baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3];
  const mask = -1 << (32 - range.mask);

  return (ipNum & mask) === (baseNum & mask);
}

/**
 * IP whitelist middleware factory
 */
export function ipWhitelist(allowedRanges: string[]) {
  const ranges = allowedRanges.map(parseCIDR);

  return async (c: Context, next: Next) => {
    const clientIP = getClientIP(c);

    if (!clientIP) {
      // No IP detected (localhost/dev scenario) - allow
      await next();
      return;
    }

    const allowed = ranges.some((range) => isIPInRange(clientIP, range));

    if (!allowed) {
      console.warn(`Blocked request from non-whitelisted IP: ${clientIP}`);
      return c.json(
        {
          error: 'Access denied',
          message: 'Your IP address is not whitelisted',
        },
        403
      );
    }

    await next();
  };
}
