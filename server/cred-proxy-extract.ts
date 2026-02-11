/**
 * Credential Proxy — Pure field extraction functions.
 *
 * Maps Bitwarden vault item fields to environment variable format.
 * No I/O — all functions are directly testable.
 *
 * @module server/cred-proxy-extract
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  allowlist: Record<string, { vaultItem: string; map: Record<string, string> }>;
  folderFallback?: { folder: string };
}

// ---------------------------------------------------------------------------
// Field Extraction
// ---------------------------------------------------------------------------

/**
 * Extract specific fields from a BW item using a mapping.
 *
 * Field path formats:
 * - `login.password` → item.login.password
 * - `login.username` → item.login.username
 * - `login.uri` → item.login.uris[0].uri
 * - `field:<name>` → item.fields.find(f => f.name === name).value
 * - `notes` → item.notes
 *
 * Returns null for unresolvable paths (doesn't throw).
 */
export function extractFields(
  item: Record<string, any>,
  mapping: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [envVar, path] of Object.entries(mapping)) {
    const value = resolvePath(item, path);
    if (value != null) {
      result[envVar] = value;
    }
  }

  return result;
}

/**
 * Auto-generate env var names from a BW item's fields.
 *
 * - Login username → USERNAME, password → PASSWORD
 * - Login URI → URI
 * - Custom fields → field name uppercased, spaces → underscores
 * - Notes → NOTES (only if non-empty)
 * - Skips null/empty values
 */
export function autoMapFields(item: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};

  // Login fields
  if (item.login) {
    if (item.login.username) result.USERNAME = item.login.username;
    if (item.login.password) result.PASSWORD = item.login.password;
    if (item.login.uris?.length > 0 && item.login.uris[0].uri) {
      result.URI = item.login.uris[0].uri;
    }
  }

  // Custom fields
  if (Array.isArray(item.fields)) {
    for (const field of item.fields) {
      if (field.name && field.value) {
        const envName = field.name.toUpperCase().replace(/\s+/g, '_');
        result[envName] = field.value;
      }
    }
  }

  // Notes
  if (item.notes) {
    result.NOTES = item.notes;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function resolvePath(item: Record<string, any>, path: string): string | null {
  if (path === 'notes') return item.notes ?? null;

  if (path === 'login.password') return item.login?.password ?? null;
  if (path === 'login.username') return item.login?.username ?? null;
  if (path === 'login.uri') return item.login?.uris?.[0]?.uri ?? null;

  if (path.startsWith('field:')) {
    const fieldName = path.slice(6);
    const field = item.fields?.find((f: any) => f.name === fieldName);
    return field?.value ?? null;
  }

  return null;
}
