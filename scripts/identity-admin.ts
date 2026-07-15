#!/usr/bin/env bun
/**
 * Workload-identity operator CLI (issue #15).
 *
 * Issue, list, revoke and rotate workload-identity tokens. The token value is
 * printed EXACTLY ONCE at issuance/rotation; all other output is metadata only.
 *
 * Usage:
 *   bun run scripts/identity-admin.ts issue  --subject <s> --audiences rest,mcp [--ttl <seconds>]
 *   bun run scripts/identity-admin.ts list
 *   bun run scripts/identity-admin.ts revoke --id <id>
 *   bun run scripts/identity-admin.ts rotate --id <id> [--overlap <seconds>]
 *
 * Storage: VW_STATE_DIR (default ~/.vaultwarden-secrets/state), 0600 JSON file.
 *
 * @module scripts/identity-admin
 */

import { getIdentityService } from "../server/identity/identity";

interface Args {
  _: string[];
  subject?: string;
  audiences?: string;
  ttl?: string;
  id?: string;
  overlap?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2) as keyof Args;
      const val = argv[i + 1];
      (args as Record<string, unknown>)[key] = val;
      i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage(): never {
  console.error(`vaultwarden-secrets identity admin

  issue  --subject <s> --audiences rest,mcp,proxy [--ttl <seconds>]
  list
  revoke --id <id>
  rotate --id <id> [--overlap <seconds>]
`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const service = getIdentityService();

  switch (cmd) {
    case "issue": {
      if (!args.subject || !args.audiences) usage();
      const audiences = args.audiences
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const ttlSeconds = args.ttl ? parseInt(args.ttl, 10) : undefined;
      const { token, id } = await service.issueToken({
        subject: args.subject,
        audiences,
        ttlSeconds,
      });
      console.log(`id:        ${id}`);
      console.log(`subject:   ${args.subject}`);
      console.log(`audiences: ${audiences.join(", ")}`);
      console.log(`ttl:       ${ttlSeconds ?? "none"}`);
      console.log("");
      console.log("token (shown once — store it now):");
      console.log(token);
      break;
    }

    case "list": {
      const records = await service.listRecords();
      if (records.length === 0) {
        console.log("(no tokens)");
        break;
      }
      for (const r of records) {
        const status = r.revokedAt
          ? "REVOKED"
          : r.supersededAt
            ? `superseded@${r.supersededAt}`
            : "active";
        console.log(
          `${r.id}  subject=${r.subject}  aud=[${r.audiences.join(",")}]  exp=${r.expiresAt ?? "never"}  ${status}`,
        );
      }
      break;
    }

    case "revoke": {
      if (!args.id) usage();
      await service.revokeToken(args.id);
      console.log(`revoked ${args.id}`);
      break;
    }

    case "rotate": {
      if (!args.id) usage();
      const overlap = args.overlap ? parseInt(args.overlap, 10) : 300;
      const { token, id } = await service.rotateToken(args.id, overlap);
      console.log(`rotated ${args.id} -> ${id} (overlap ${overlap}s)`);
      console.log("");
      console.log("new token (shown once — store it now):");
      console.log(token);
      break;
    }

    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
