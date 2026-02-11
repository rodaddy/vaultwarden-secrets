/**
 * Security profiles for the secrets server
 * Choose based on your deployment environment and security requirements
 */

export type AuditLevel = 'none' | 'basic' | 'standard' | 'detailed' | 'forensic';
export type AuthType = false | 'bearer' | 'oauth2' | 'mtls+jwt';

export interface RateLimitConfig {
  requests: number;
  window: string;
  burst?: number;
}

export interface MonitoringConfig {
  alerts: boolean;
  anomalyDetection: boolean;
  failedAuthThreshold: number;
}

export interface SecurityProfile {
  name: string;
  description: string;
  auth: AuthType;
  ipWhitelist: boolean | string[] | 'auto'; // 'auto' = auto-detect local network
  tls: boolean | 'recommended' | 'required' | 'required+strict';
  audit: AuditLevel;
  rateLimit: false | RateLimitConfig;
  clientAuth?: 'none' | 'api-key' | 'oauth2' | 'certificate';
  tokenExpiry?: number;
  refreshTokens?: boolean;
  requireClientCert?: boolean;
  allowedCertFingerprints?: string[];
  secretsEncrypted?: boolean;
  monitoring?: MonitoringConfig;
  warning?: string;
  /** Allow create/update/delete operations via MCP */
  allowWrites?: boolean;
  /** Require confirmation (destructiveHint) for update/delete operations */
  writeConfirmation?: boolean;
  /** Restrict MCP access to items in these VW folders (empty = unrestricted) */
  folderScope?: string[];
}

export const SecurityProfiles = {
  'feeling-lucky': {
    name: 'Feeling Lucky',
    description: 'DEVELOPMENT ONLY - Auto-detects local network for security',
    auth: false,
    ipWhitelist: 'auto', // Auto-detect local /24
    tls: false,
    audit: 'basic',
    rateLimit: false,
    clientAuth: 'none',
    allowWrites: true,
    writeConfirmation: false,
    folderScope: [],
    warning: '⚠️  NEVER USE IN PRODUCTION - NO SECURITY ⚠️',
  },

  'im-aware': {
    name: "I'm Aware",
    description: 'Simple API token - Good for homelab/internal networks',
    auth: 'bearer',
    ipWhitelist: 'auto', // Auto-detect local /24, can add more via env
    tls: 'recommended',
    audit: 'standard',
    rateLimit: {
      requests: 100,
      window: '1m',
    },
    clientAuth: 'api-key',
    allowWrites: true,
    writeConfirmation: true,
    folderScope: ['Infrastructure'],
  },

  'im-a-dev': {
    name: "I'm a Dev",
    description: 'OAuth2 flow - Production-ready for human users',
    auth: 'oauth2',
    ipWhitelist: 'auto', // Auto-detect local /24, Docker-aware
    tls: 'required',
    audit: 'detailed',
    rateLimit: {
      requests: 60,
      window: '1m',
    },
    clientAuth: 'oauth2',
    tokenExpiry: 900, // 15 minutes
    refreshTokens: true,
    allowWrites: true,
    writeConfirmation: true,
    folderScope: ['Infrastructure'],
  },

  'trust-no-one': {
    name: 'Trust No One',
    description: 'MAXIMUM PARANOIA - Multi-layer defense in depth',
    auth: 'mtls+jwt',
    ipWhitelist: ['127.0.0.1/32'], // Localhost only, must add IPs explicitly
    tls: 'required+strict',
    audit: 'forensic',
    rateLimit: {
      requests: 30,
      window: '1m',
      burst: 5,
    },
    clientAuth: 'certificate',
    tokenExpiry: 300, // 5 minutes
    requireClientCert: true,
    allowedCertFingerprints: [],
    secretsEncrypted: true,
    monitoring: {
      alerts: true,
      anomalyDetection: true,
      failedAuthThreshold: 3,
    },
    allowWrites: false,
    writeConfirmation: true,
    folderScope: [],
  },
} as const satisfies Record<string, SecurityProfile>;

/**
 * Profile aliases - for backwards compatibility and fun
 * All point to trust-no-one (the maximum paranoia profile)
 */
export const ProfileAliases: Record<string, keyof typeof SecurityProfiles> = {
  'openclaw': 'trust-no-one',
  'tinfoil-hat': 'trust-no-one',
  'maximum-paranoia': 'trust-no-one',
  'aluminum-foil': 'trust-no-one',
  'aluminium-hat': 'trust-no-one',
  'fort-knox': 'trust-no-one',
};

export type ProfileName = keyof typeof SecurityProfiles;

/**
 * Get security profile by name with validation
 * Supports aliases for backwards compatibility
 */
export function getProfile(name: string): SecurityProfile {
  // Check for alias first
  const resolvedName = ProfileAliases[name] || name;

  if (!(resolvedName in SecurityProfiles)) {
    const allOptions = [
      ...Object.keys(SecurityProfiles),
      ...Object.keys(ProfileAliases),
    ].join(', ');
    throw new Error(
      `Unknown security profile: ${name}. Valid options: ${allOptions}`
    );
  }
  return SecurityProfiles[resolvedName as ProfileName];
}

/**
 * Validate profile configuration
 */
export function validateProfile(profile: SecurityProfile): void {
  // Check for dangerous configs
  if (profile.auth === false && process.env.NODE_ENV === 'production') {
    throw new Error(
      'Cannot use "feeling-lucky" profile in production (NODE_ENV=production)'
    );
  }

  if (profile.tls === 'required' && !process.env.TLS_CERT) {
    throw new Error(
      `Profile "${profile.name}" requires TLS but TLS_CERT not set`
    );
  }

  if (profile.requireClientCert && !profile.allowedCertFingerprints?.length) {
    console.warn(
      `⚠️  Client cert required but no fingerprints configured - will reject all requests`
    );
  }
}
