import { describe, test, expect } from "bun:test";
import type { BitwVaultItem } from "../../snapshot";
import { resolveService } from "../service-resolver";

function makeItem(
  overrides: Partial<BitwVaultItem> & { name: string },
): BitwVaultItem {
  return {
    id: crypto.randomUUID(),
    type: 1,
    revisionDate: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveService", () => {
  test("basic multi-host service", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "PROXMOX_API",
        login: {
          username: "claude@pve!mcp",
          password: "secret-token",
          uris: [{ match: null, uri: "https://proxmox.local:8006" }],
        },
        notes: "API credentials",
      }),
      makeItem({
        name: "proxmox01",
        login: {
          username: "root",
          password: "pass1",
          uris: [{ match: null, uri: "https://pve01.local:8006" }],
        },
      }),
      makeItem({
        name: "proxmox03",
        login: {
          username: "root",
          password: "pass3",
          uris: [{ match: null, uri: "https://pve03.local:8006" }],
        },
      }),
      makeItem({
        name: "proxmox02",
        login: {
          username: "root",
          password: "pass2",
          uris: [{ match: null, uri: "https://pve02.local:8006" }],
        },
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.service).toBe("proxmox");
    expect(result.itemCount).toBe(4);
    expect(result.api).not.toBeNull();
    expect(result.api?.username).toBe("claude@pve!mcp");
    expect(result.api?.password).toBe("secret-token");
    expect(result.api?.uri).toBe("https://proxmox.local:8006");
    expect(result.hosts).toHaveLength(3);
    expect(result.hosts[0].itemName).toBe("proxmox01");
    expect(result.hosts[1].itemName).toBe("proxmox02");
    expect(result.hosts[2].itemName).toBe("proxmox03");
  });

  test("API item with notes fallback", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "PROXMOX_API",
        notes: "Token ID: claude@pve!mcp\nToken value: abc123",
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.api).not.toBeNull();
    expect(result.api?.username).toBe("claude@pve!mcp");
    expect(result.api?.password).toBe("abc123");
  });

  test("API item with login fields preferred over notes", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "PROXMOX_API",
        login: {
          username: "login-user",
          password: "login-pass",
        },
        notes: "Token ID: notes-user\nToken value: notes-pass",
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.api?.username).toBe("login-user");
    expect(result.api?.password).toBe("login-pass");
  });

  test("cross-reference parsing", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "proxmox01",
        notes: "See PROXMOX_API for cluster access",
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].crossRef).toBe("PROXMOX_API");
  });

  test("no API item", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "redis01",
        login: { username: "admin", password: "pass1" },
      }),
      makeItem({
        name: "redis02",
        login: { username: "admin", password: "pass2" },
      }),
    ];

    const result = resolveService("redis", items);

    expect(result.api).toBeNull();
    expect(result.hosts).toHaveLength(2);
    expect(result.itemCount).toBe(2);
  });

  test("no hosts", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "GITHUB_API",
        login: {
          username: "token",
          password: "ghp_secret",
        },
      }),
    ];

    const result = resolveService("github", items);

    expect(result.api).not.toBeNull();
    expect(result.api?.username).toBe("token");
    expect(result.hosts).toHaveLength(0);
    expect(result.itemCount).toBe(1);
  });

  test("empty result for unknown service", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "something-else",
        login: { username: "user", password: "pass" },
      }),
    ];

    const result = resolveService("unknown", items);

    expect(result.service).toBe("unknown");
    expect(result.api).toBeNull();
    expect(result.hosts).toHaveLength(0);
    expect(result.itemCount).toBe(0);
  });

  test("name boundary matching", () => {
    const items: BitwVaultItem[] = [
      makeItem({ name: "proxmox01" }), // Match: digit after prefix
      makeItem({ name: "PROXMOX_API" }), // Match: _API suffix
      makeItem({ name: "proxmox-api" }), // Match: -api suffix
      makeItem({ name: "proxmox" }), // Match: exact prefix
      makeItem({ name: "proxmox-related-doc" }), // No match
      makeItem({ name: "proxmox_helper" }), // No match
    ];

    const result = resolveService("proxmox", items);

    expect(result.itemCount).toBe(4); // Only the first 4 items
    const matchedNames = [
      result.api?.itemName,
      ...result.hosts.map((h) => h.itemName),
    ].filter(Boolean);
    expect(matchedNames).toContain("proxmox01");
    expect(matchedNames).toContain("PROXMOX_API");
    expect(matchedNames).toContain("proxmox-api");
    expect(matchedNames).toContain("proxmox");
    expect(matchedNames).not.toContain("proxmox-related-doc");
    expect(matchedNames).not.toContain("proxmox_helper");
  });

  test("case insensitivity", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "PROXMOX_API",
        login: { username: "user", password: "pass" },
      }),
      makeItem({
        name: "ProxMox01",
        login: { username: "root", password: "pass" },
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.itemCount).toBe(2);
    expect(result.api?.itemName).toBe("PROXMOX_API");
    expect(result.hosts[0].itemName).toBe("ProxMox01");
  });

  test("custom fields extraction", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "proxmox01",
        fields: [
          { name: "hostname", value: "pve01.local", type: 0 },
          { name: "cluster", value: "production", type: 0 },
        ],
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].fields).toEqual({
      hostname: "pve01.local",
      cluster: "production",
    });
  });

  test("single item service", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "cloudflare-api",
        login: {
          username: "api-token",
          password: "cf-secret",
        },
      }),
    ];

    const result = resolveService("cloudflare", items);

    expect(result.api).not.toBeNull();
    expect(result.api?.itemName).toBe("cloudflare-api");
    expect(result.api?.username).toBe("api-token");
    expect(result.hosts).toHaveLength(0);
    expect(result.itemCount).toBe(1);
  });

  test("notes token parsing variations", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "service1-api",
        notes: "Token ID: id1\nSecret: secret1",
      }),
      makeItem({
        name: "service2-api",
        notes: "Token ID: id2\nToken Value: secret2",
      }),
    ];

    const result1 = resolveService("service1", items);
    const result2 = resolveService("service2", items);

    expect(result1.api?.username).toBe("id1");
    expect(result1.api?.password).toBe("secret1");
    expect(result2.api?.username).toBe("id2");
    expect(result2.api?.password).toBe("secret2");
  });

  test("multiple URIs - uses first", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "proxmox01",
        login: {
          uris: [
            { match: null, uri: "https://primary.local" },
            { match: null, uri: "https://backup.local" },
          ],
        },
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.hosts[0].uri).toBe("https://primary.local");
  });

  test("API credentials from custom fields (Secure Note)", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "PROXMOX_API",
        type: 2, // Secure Note — no login field
        fields: [
          { name: "Token ID", value: "claude@pve!mcp", type: 0 },
          { name: "Token value", value: "secret-token-123", type: 1 },
        ],
        notes: "Proxmox cluster API token for MCP access",
      }),
    ];

    const result = resolveService("proxmox", items);

    expect(result.api).not.toBeNull();
    expect(result.api?.username).toBe("claude@pve!mcp");
    expect(result.api?.password).toBe("secret-token-123");
    expect(result.api?.notes).toBe("Proxmox cluster API token for MCP access");
    expect(result.api?.fields["Token ID"]).toBe("claude@pve!mcp");
  });

  test("login fields still preferred over custom fields", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "SERVICE_API",
        login: { username: "login-user", password: "login-pass" },
        fields: [
          { name: "Token ID", value: "field-user", type: 0 },
          { name: "Token value", value: "field-pass", type: 1 },
        ],
      }),
    ];

    const result = resolveService("service", items);

    expect(result.api?.username).toBe("login-user");
    expect(result.api?.password).toBe("login-pass");
  });

  test("missing optional fields", () => {
    const items: BitwVaultItem[] = [
      makeItem({
        name: "minimal-api",
        // No login, notes, fields
      }),
    ];

    const result = resolveService("minimal", items);

    expect(result.api).not.toBeNull();
    expect(result.api?.username).toBeNull();
    expect(result.api?.password).toBeNull();
    expect(result.api?.uri).toBeNull();
    expect(result.api?.notes).toBeNull();
    expect(result.api?.fields).toEqual({});
  });
});
