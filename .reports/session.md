# Session Summary

**Date:** 2026-02-11 (afternoon)
**Project:** vaultwarden-secrets

## What Got Done
- Added `get_service` MCP tool — aggregates related vault items by service name (PROXMOX_API + proxmox01/02/03 → single response)
- Created `server/service-resolver.ts` — pure function module with name boundary matching, credential fallback chain (login → custom fields → notes parsing), cross-reference parsing
- 16 tests for service resolver, 198 total passing, clean typecheck
- Normalized PROXMOX_API vault item — added custom fields (Token ID, Token value) since Secure Notes can't have login fields
- Built CD pipeline: `git deploy` alias pushes to GitHub then curls internal deploy trigger on LXC 214
- Deploy trigger (`deploy/webhook.ts`) on port 3002 — Bun HTTP server, systemd service
- Deploy script (`deploy/deploy.sh`) — idempotent, compares HEAD vs origin, only restarts if changed
- Version bumped to v0.7.0, deployed and verified live
- Added 8 corrections to `~/Development/CLAUDE.md` from session gotchas
- Updated project memory with CD pipeline, v0.7.0 architecture, and gotchas

## Key Decisions
- **Custom fields over notes for credentials:** BW Secure Notes can't become Login items (type change not supported). Custom fields work on all item types and are the preferred path in the resolver's fallback chain.
- **Internal deploy trigger over GitHub webhooks:** rodaddy.live DNS is pihole-only (no public records). GitHub can't reach the LXC. Solution: `git deploy` alias curls LXC directly from local network after push.
- **Pull-based CD:** LXC pulls from GitHub using read-only deploy key. No SSH keys stored in GitHub secrets. Idempotent — safe to trigger multiple times.
- **Polling timer as fallback:** `vw-deploy.timer` exists but disabled. Manual `git deploy` preferred for instant feedback.

## Files Changed
- `server/service-resolver.ts` — NEW: service discovery/aggregation logic
- `server/__tests__/service-resolver.test.ts` — NEW: 16 tests for resolver
- `server/mcp.ts` — Added `get_service` tool, import, version bump to 0.7.0
- `deploy/webhook.ts` — NEW: internal deploy trigger HTTP server
- `deploy/deploy.sh` — NEW: idempotent pull + restart script
- `deploy/systemd/vw-deploy-webhook.service` — NEW: systemd unit for deploy trigger
- `deploy/systemd/vw-deploy.service` — NEW: oneshot deploy service
- `deploy/systemd/vw-deploy.timer` — NEW: fallback polling timer (disabled)

## Next Session
- **PAI skill update** — update `~/.config/pai/Skills/vaultwarden-secrets/SKILL.md` to document `get_service` tool
- **Public DNS for rodaddy.live** — when ready, add Cloudflare records to enable real GitHub webhooks
- **Main branch merge** — feature/installer-cli has accumulated enough features for a merge to main
- **LiteLLM integration** — register MCP through LiteLLM gateway
