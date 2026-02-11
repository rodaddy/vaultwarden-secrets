/**
 * Audit logging middleware
 * Tracks all access to secrets with configurable detail levels
 */

import type { Context, Next } from 'hono';
import type { AuditLevel } from '../profiles';
import { getClientIP } from '../utils/network';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface AuditLogEntry {
  timestamp: string;
  clientId?: string;
  clientIP?: string | null;
  method: string;
  path: string;
  secretName?: string;
  status?: number;
  duration?: number;
  userAgent?: string;
  error?: string;
}

export class AuditLogger {
  private level: AuditLevel;
  private logFile?: string;

  constructor(level: AuditLevel, logFile?: string) {
    this.level = level;
    this.logFile = logFile;

    if (this.logFile) {
      // Ensure log directory exists
      const dir = dirname(this.logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  log(entry: AuditLogEntry): void {
    if (this.level === 'none') return;

    const logEntry = this.formatEntry(entry);

    // Console output (always if logging enabled)
    console.log(logEntry);

    // File output
    if (this.logFile) {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    }
  }

  private formatEntry(entry: AuditLogEntry): string {
    const parts: string[] = [];

    // Timestamp
    parts.push(`[${entry.timestamp}]`);

    // Client info (standard and above)
    if (this.level !== 'basic') {
      if (entry.clientId) parts.push(`client=${entry.clientId}`);
      if (entry.clientIP) parts.push(`ip=${entry.clientIP}`);
    }

    // Request
    parts.push(`${entry.method} ${entry.path}`);

    // Secret name (detailed and above)
    if (this.level === 'detailed' || this.level === 'forensic') {
      if (entry.secretName) parts.push(`secret=${entry.secretName}`);
    }

    // Status and duration
    if (entry.status) parts.push(`status=${entry.status}`);
    if (entry.duration) parts.push(`duration=${entry.duration}ms`);

    // User agent (forensic only)
    if (this.level === 'forensic' && entry.userAgent) {
      parts.push(`ua="${entry.userAgent}"`);
    }

    // Error
    if (entry.error) parts.push(`error="${entry.error}"`);

    return parts.join(' ');
  }

  middleware() {
    return async (c: Context, next: Next) => {
      const start = Date.now();

      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        method: c.req.method,
        path: c.req.path,
        clientId: c.get('clientId'),
        clientIP: getClientIP(c),
      };

      // Add user agent for forensic logging
      if (this.level === 'forensic') {
        entry.userAgent = c.req.header('User-Agent');
      }

      try {
        await next();

        entry.status = c.res.status;
        entry.duration = Date.now() - start;

        // Extract secret name from path for detailed logging
        if (this.level === 'detailed' || this.level === 'forensic') {
          const match = c.req.path.match(/\/secret\/([^/]+)/);
          if (match) {
            entry.secretName = decodeURIComponent(match[1]);
          }
        }

        this.log(entry);
      } catch (error) {
        entry.status = 500;
        entry.duration = Date.now() - start;
        entry.error = error instanceof Error ? error.message : String(error);

        this.log(entry);
        throw error;
      }
    };
  }
}

/**
 * Create audit logger middleware
 */
export function auditLogger(level: AuditLevel, logFile?: string) {
  const logger = new AuditLogger(level, logFile);
  return logger.middleware();
}
