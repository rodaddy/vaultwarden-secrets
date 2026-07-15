/**
 * Pure resolution logic for the get_credential MCP tool.
 *
 * Split out of server/mcp.ts (matching the service-resolver / vault-client
 * pattern) so the exact-then-fuzzy match algorithm and the scope decision flow
 * are unit-testable offline without a live vault or snapshot. The MCP tool in
 * mcp.ts is a thin adapter that supplies the real I/O closures.
 *
 * @module server/credential-resolver
 */

/** Fuzzy score a candidate name against a lowercased query (higher = better). */
export function scoreName(name: string, lowerQuery: string): number {
  const lowerName = name.toLowerCase();
  let score = 0;
  let queryIdx = 0;
  for (const char of lowerName) {
    if (queryIdx < lowerQuery.length && char === lowerQuery[queryIdx]) {
      score += 10;
      queryIdx++;
    }
  }
  if (lowerName.includes(lowerQuery)) score += 50;
  if (lowerName.startsWith(lowerQuery)) score += 100;
  return score;
}

/**
 * Rank scoped candidate names for a query, best first. Only names with a
 * positive score are returned. Deterministic: ties preserve input order.
 */
export function rankCandidates(names: string[], query: string): string[] {
  const lowerQuery = query.toLowerCase();
  return names
    .map((name) => ({ name, score: scoreName(name, lowerQuery) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.name);
}

export type CredentialMatchType = "exact" | "fuzzy";

/** Classify a resolved item name against the original query. */
export function matchType(
  itemName: string,
  query: string,
): CredentialMatchType {
  return itemName.toLowerCase() === query.toLowerCase() ? "exact" : "fuzzy";
}

export interface CredentialResolverDeps {
  /** Exact snapshot lookup, folder-scope aware. Returns the item name or null. */
  findScoped: (name: string) => Promise<string | null>;
  /** Scoped candidate names for fuzzy fallback. */
  listScoped: () => Promise<string[]>;
  /** Read a secret value by name/path. */
  getSecret: (path: string) => Promise<string>;
  /** Read the full field object for an item name. */
  getSecretObject: (name: string) => Promise<Record<string, string>>;
}

export type CredentialResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Generic not-found message reused for BOTH "no match" and "match not in
 * allowed scope" so the not-in-scope outcome is INDISTINGUISHABLE from
 * not-found — a caller cannot use it to confirm the existence of an
 * out-of-scope item (enumeration parity).
 */
const NOT_FOUND = (query: string) =>
  `No credentials found matching "${query}". Try a different search term or use list_secrets to browse.`;

/**
 * Resolve a credential: exact match first, else best fuzzy candidate. If a
 * specific `field` is requested, return just that field's value; otherwise
 * return all fields plus a best-effort primary value. Never returns secret
 * material in an error.
 */
export async function resolveCredential(
  query: string,
  field: string | undefined,
  deps: CredentialResolverDeps,
): Promise<CredentialResult> {
  // Step 1: exact name match (scope-aware).
  let name = await deps.findScoped(query);

  // Step 2: fuzzy fallback over scoped names.
  if (!name) {
    const ranked = rankCandidates(await deps.listScoped(), query);
    if (ranked.length === 0) {
      return { ok: false, error: NOT_FOUND(query) };
    }
    name = await deps.findScoped(ranked[0]!);
    if (!name) {
      // Best candidate is out of scope. Return the SAME generic message as
      // no-match so existence of the out-of-scope item is not confirmable.
      return { ok: false, error: NOT_FOUND(query) };
    }
  }

  const result: Record<string, unknown> = {
    name,
    matchType: matchType(name, query),
  };

  if (field) {
    result.field = field;
    result.value = await deps.getSecret(`${name}.${field}`);
  } else {
    result.fields = await deps.getSecretObject(name);
    // Best-effort primary value (password → notes → first custom field).
    try {
      result.value = await deps.getSecret(name);
    } catch {
      /* no primary value available */
    }
  }

  return { ok: true, value: result };
}
