/**
 * Per-client folder scoping for the secrets server
 *
 * Restricts which VW items a client can access based on folder membership.
 * Loaded from API_FOLDERS_<CLIENT> env vars (comma-separated folder names).
 * Clients without a folder restriction see everything.
 */

import { $ } from "bun";
import { getVaultSession } from "../../keychain";
import { getActiveVault } from "../../index";

export class FolderScope {
  /** folder name (lowercase) → VW folder ID */
  private folderNameToId = new Map<string, string>();

  /** item name → VW folder ID (null = no folder) */
  private itemToFolderId = new Map<string, string | null>();

  /** clientId → Set of allowed folder IDs */
  private clientAllowedFolderIds = new Map<string, Set<string>>();

  /** Raw config: clientId → folder names */
  private clientFolderNames: Map<string, string[]>;

  /**
   * Scope keys of clients that are CONFIGURED as restricted (an
   * API_FOLDERS_<CLIENT> entry exists), independent of whether their folders
   * resolved in the vault. Used to fail CLOSED (F4): a configured-restricted
   * client whose folders don't resolve — or a not-yet-initialized scope — must
   * deny, never fall through to unrestricted.
   */
  private configuredRestricted: Set<string>;

  private initialized = false;

  constructor(clientFolderNames: Map<string, string[]>) {
    this.clientFolderNames = clientFolderNames;
    this.configuredRestricted = new Set(
      [...clientFolderNames.keys()].map((k) => this.scopeKey(k)),
    );
  }

  /**
   * Load folder and item data from Vaultwarden.
   * Call once at startup, and again on cache clear to pick up changes.
   */
  async initialize(): Promise<void> {
    if (this.clientFolderNames.size === 0) {
      // No folder scoping configured
      this.initialized = true;
      return;
    }

    const vaultId = await getActiveVault();
    const session = await getVaultSession(vaultId);
    if (!session) {
      console.warn(
        "  ⚠  FolderScope: No vault session, folder scoping disabled",
      );
      return;
    }

    try {
      // Fetch folders and items in parallel
      const [foldersResult, itemsResult] = await Promise.all([
        $`BW_SESSION=${session} bw list folders`.quiet(),
        $`BW_SESSION=${session} bw list items`.quiet(),
      ]);

      const folders: Array<{ id: string; name: string }> = JSON.parse(
        foldersResult.stdout.toString(),
      );
      const items: Array<{ name: string; folderId: string | null }> =
        JSON.parse(itemsResult.stdout.toString());

      this.loadFrom(folders, items);
    } catch (error) {
      console.warn(
        `  ⚠  FolderScope: Init failed — ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Populate folder/item/client-scope maps from already-fetched vault data.
   * Split out of {@link initialize} so the pure resolution (name→id +
   * per-client scope) is exercisable offline without shelling out to `bw`.
   */
  loadFrom(
    folders: Array<{ id: string; name: string }>,
    items: Array<{ name: string; folderId: string | null }>,
  ): void {
    // Build folder name → ID map
    this.folderNameToId.clear();
    for (const folder of folders) {
      this.folderNameToId.set(folder.name.toLowerCase(), folder.id);
    }

    // Build item name → folder ID map
    this.itemToFolderId.clear();
    for (const item of items) {
      this.itemToFolderId.set(item.name, item.folderId);
    }

    // Resolve per-client folder names to folder IDs
    this.clientAllowedFolderIds.clear();
    for (const [clientId, folderNames] of this.clientFolderNames) {
      const folderIds = new Set<string>();
      for (const name of folderNames) {
        const id = this.folderNameToId.get(name.toLowerCase());
        if (id) {
          folderIds.add(id);
        } else {
          console.warn(
            `  ⚠  FolderScope: Folder "${name}" not found in vault (client: ${clientId})`,
          );
        }
      }
      if (folderIds.size > 0) {
        this.clientAllowedFolderIds.set(clientId, folderIds);
      }
    }

    this.initialized = true;

    // Log summary
    for (const [clientId, folderNames] of this.clientFolderNames) {
      const resolvedCount =
        this.clientAllowedFolderIds.get(clientId)?.size || 0;
      console.log(
        `  ✓ Folder Scope: ${clientId} → ${folderNames.join(", ")} (${resolvedCount} resolved)`,
      );
    }
  }

  /**
   * Normalize a subject/clientId to the key the scope map is stored under.
   *
   * SECURITY (F4): the workload-identity middleware sets clientId
   * `legacy:<client>` for legacy bearer tokens, but scopes are loaded from
   * `API_FOLDERS_<CLIENT>` keyed as `<client>` (lowercased). Without this
   * normalization a scoped legacy token (`legacy:payroll`) misses the map and
   * would be treated as UNRESTRICTED — reading out of its folder. Stripping the
   * `legacy:` prefix and lowercasing makes the lookup match the middleware's
   * subject, so a scoped legacy client fails CLOSED to its folder. A genuinely
   * unrestricted client (no matching `API_FOLDERS_*`) still resolves to no
   * scope and stays unrestricted.
   */
  private scopeKey(clientId: string): string {
    // Strip the `legacy:` prefix defensively — repeatedly — so a malformed
    // subject like `legacy:legacy:x` cannot key differently from `x` (F4 P2).
    let stripped = clientId;
    while (stripped.startsWith("legacy:")) {
      stripped = stripped.slice("legacy:".length);
    }
    return stripped.toLowerCase();
  }

  /**
   * Resolve the effective scope decision for a client: whether it is
   * restricted, and to which folders. Fails CLOSED (F4): a client configured as
   * restricted whose folders did not resolve — or any lookup before init
   * completes for a configured-restricted client — is `restricted` with an
   * EMPTY allow set, denying every item. Only a genuinely-unconfigured client
   * (no API_FOLDERS_* entry) is unrestricted.
   */
  private resolveScope(clientId: string): {
    restricted: boolean;
    allowed: Set<string>;
  } {
    const key = this.scopeKey(clientId);
    const configured = this.configuredRestricted.has(key);
    if (!configured) return { restricted: false, allowed: new Set() };
    // Configured-restricted: use resolved folders if present, else empty (deny).
    return {
      restricted: true,
      allowed: this.clientAllowedFolderIds.get(key) ?? new Set(),
    };
  }

  /**
   * Whether this client is configured as folder-restricted. This is a property
   * of configuration (an API_FOLDERS_<CLIENT> entry), NOT of whether the
   * folders resolved — so it is stable across init state and fail-closed.
   */
  isRestricted(clientId: string): boolean {
    return this.configuredRestricted.has(this.scopeKey(clientId));
  }

  /** Check if a specific item is accessible to a client */
  isAllowed(clientId: string, itemName: string): boolean {
    const { restricted, allowed } = this.resolveScope(clientId);
    if (!restricted) return true; // Genuinely-unconfigured client → unrestricted

    // Configured-restricted: allow ONLY items in a resolved allowed folder.
    // Zero resolved folders (unresolved/failed init) → deny all (fail closed).
    const itemFolderId = this.itemToFolderId.get(itemName);
    if (!itemFolderId) return false; // No folder / unknown item → blocked
    return allowed.has(itemFolderId);
  }

  /** Filter a list of item names to only those accessible to a client */
  filterItems(clientId: string, itemNames: string[]): string[] {
    const { restricted, allowed } = this.resolveScope(clientId);
    if (!restricted) return itemNames; // Genuinely-unconfigured client

    // Configured-restricted with zero resolved folders → empty (fail closed).
    return itemNames.filter((name) => {
      const folderId = this.itemToFolderId.get(name);
      return folderId != null && allowed.has(folderId);
    });
  }

  /** Refresh folder/item mappings (call after cache clear or VW changes) */
  async refresh(): Promise<void> {
    await this.initialize();
  }
}

/**
 * Load per-client folder scopes from environment variables.
 * Format: API_FOLDERS_<CLIENT>=folder1,folder2
 */
export function loadFolderScopes(): Map<string, string[]> {
  const scopes = new Map<string, string[]>();

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("API_FOLDERS_") && value) {
      const clientId = key.replace("API_FOLDERS_", "").toLowerCase();
      const folders = value
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      if (folders.length > 0) {
        scopes.set(clientId, folders);
      }
    }
  }

  return scopes;
}
