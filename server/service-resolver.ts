import type { BitwVaultItem } from "../snapshot";

export interface ServiceApiInfo {
  itemName: string;
  username: string | null;
  password: string | null;
  uri: string | null;
  notes: string | null;
  fields: Record<string, string>;
}

export interface ServiceHostInfo {
  itemName: string;
  uri: string | null;
  username: string | null;
  password: string | null;
  notes: string | null;
  fields: Record<string, string>;
  crossRef: string | null;
}

export interface ServiceInfo {
  service: string;
  api: ServiceApiInfo | null;
  hosts: ServiceHostInfo[];
  itemCount: number;
}

interface ParsedTokens {
  tokenId: string | null;
  tokenValue: string | null;
}

function parseNotesTokens(notes: string | undefined | null): ParsedTokens {
  if (!notes) {
    return { tokenId: null, tokenValue: null };
  }

  const lines = notes.split("\n");
  let tokenId: string | null = null;
  let tokenValue: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("Token ID:")) {
      tokenId = trimmed.substring("Token ID:".length).trim();
    } else if (
      trimmed.startsWith("Token value:") ||
      trimmed.startsWith("Token Value:") ||
      trimmed.startsWith("Secret:")
    ) {
      const prefix = trimmed.startsWith("Secret:")
        ? "Secret:"
        : trimmed.startsWith("Token Value:")
          ? "Token Value:"
          : "Token value:";
      tokenValue = trimmed.substring(prefix.length).trim();
    }
  }

  return { tokenId, tokenValue };
}

function extractFields(
  fields: Array<{ name: string; value: string; type: number }> | undefined,
): Record<string, string> {
  if (!fields) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const field of fields) {
    result[field.name] = field.value;
  }
  return result;
}

function parseCrossReference(notes: string | undefined | null): string | null {
  if (!notes) {
    return null;
  }

  const match = notes.match(/See\s+(\S+)\s+for/i);
  return match ? match[1] : null;
}

function isApiItem(name: string): boolean {
  return /_api$/i.test(name) || /-api$/i.test(name);
}

function matchesServicePrefix(
  itemName: string,
  servicePrefix: string,
): boolean {
  const lowerName = itemName.toLowerCase();
  const lowerPrefix = servicePrefix.toLowerCase();

  if (!lowerName.startsWith(lowerPrefix)) {
    return false;
  }

  if (lowerName === lowerPrefix) {
    return true;
  }

  const suffix = lowerName.substring(lowerPrefix.length);

  // Match if suffix starts with a digit, or is exactly _api or -api
  return /^(_api|-api|\d)/.test(suffix);
}

function extractCredentialsFromFields(
  fields: Record<string, string>,
): ParsedTokens {
  return {
    tokenId: fields["Token ID"] ?? fields["username"] ?? null,
    tokenValue:
      fields["Token value"] ??
      fields["Token Value"] ??
      fields["password"] ??
      fields["Secret"] ??
      null,
  };
}

function buildApiInfo(item: BitwVaultItem): ServiceApiInfo {
  const fields = extractFields(item.fields);
  const fieldCreds = extractCredentialsFromFields(fields);
  const notesCreds = parseNotesTokens(item.notes);

  // Prefer login fields → custom fields → notes parsing
  const username =
    item.login?.username ?? fieldCreds.tokenId ?? notesCreds.tokenId ?? null;
  const password =
    item.login?.password ??
    fieldCreds.tokenValue ??
    notesCreds.tokenValue ??
    null;
  const uri = item.login?.uris?.[0]?.uri ?? null;

  return {
    itemName: item.name,
    username,
    password,
    uri,
    notes: item.notes ?? null,
    fields,
  };
}

function buildHostInfo(item: BitwVaultItem): ServiceHostInfo {
  const fields = extractFields(item.fields);
  const crossRef = parseCrossReference(item.notes);
  const uri = item.login?.uris?.[0]?.uri ?? null;

  return {
    itemName: item.name,
    uri,
    username: item.login?.username ?? null,
    password: item.login?.password ?? null,
    notes: item.notes ?? null,
    fields,
    crossRef,
  };
}

/**
 * Strip denied fields from a resolveService() result. `filterFlat` is the
 * subject-bound field-deny filter (server/utils/folder-scope filterDeniedFields
 * partially applied) — it removes denied keys from a flat object. The
 * credential-bearing top-level keys (username/password/uri/notes) are the real
 * flat field names the denylist matches; a stripped key becomes null to
 * preserve the declared response shape. Each item's custom `fields` record is
 * filtered too. Pure + injectable so get_service's enforcement is unit-testable.
 *
 * SECURITY: get_service must honor the same denylist as get_secret_fields /
 * get_credential; routing every returned item through the shared flat filter
 * here is that single enforcement point for this tool.
 */
export function filterServiceInfoDenied(
  info: ServiceInfo,
  filterFlat: <T extends Record<string, unknown>>(obj: T) => T,
): ServiceInfo {
  const scrubCreds = (c: {
    username: string | null;
    password: string | null;
    uri: string | null;
    notes: string | null;
  }) => {
    const kept = filterFlat({
      username: c.username,
      password: c.password,
      uri: c.uri,
      notes: c.notes,
    });
    return {
      username: kept.username ?? null,
      password: kept.password ?? null,
      uri: kept.uri ?? null,
      notes: kept.notes ?? null,
    };
  };
  const scrubApi = (api: ServiceApiInfo): ServiceApiInfo => ({
    itemName: api.itemName,
    ...scrubCreds(api),
    fields: filterFlat(api.fields),
  });
  const scrubHost = (host: ServiceHostInfo): ServiceHostInfo => ({
    itemName: host.itemName,
    ...scrubCreds(host),
    fields: filterFlat(host.fields),
    crossRef: host.crossRef,
  });
  return {
    service: info.service,
    api: info.api ? scrubApi(info.api) : null,
    hosts: info.hosts.map(scrubHost),
    itemCount: info.itemCount,
  };
}

export function resolveService(
  serviceName: string,
  items: BitwVaultItem[],
): ServiceInfo {
  const matchedItems = items.filter((item) =>
    matchesServicePrefix(item.name, serviceName),
  );

  const apiItems = matchedItems.filter((item) => isApiItem(item.name));
  const hostItems = matchedItems.filter((item) => !isApiItem(item.name));

  // Use first API item as the primary API, treat any additional API items as hosts
  const api = apiItems.length > 0 ? buildApiInfo(apiItems[0]) : null;
  const additionalApiHosts = apiItems.slice(1).map(buildHostInfo);

  const allHosts = [
    ...hostItems.map(buildHostInfo),
    ...additionalApiHosts,
  ].sort((a, b) => a.itemName.localeCompare(b.itemName));

  return {
    service: serviceName,
    api,
    hosts: allHosts,
    itemCount: matchedItems.length,
  };
}
