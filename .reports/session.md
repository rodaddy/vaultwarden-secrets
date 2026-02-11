# Session Summary

**Date:** 2026-02-11
**Project:** vaultwarden-secrets

## What Got Done
- Diagnosed and fixed stale snapshot issue — other CC sessions couldn't find new Proxmox cluster secrets
- Fixed systemd `vw-snapshot.timer` on LXC 214: wrong user (`vw-secrets` doesn't exist → `root`) and wrong bun path (`/usr/local/bin/bun` → `/root/.bun/bin/bun`). Timer now fires every 15 min successfully.
- Extended `SecurityProfile` with `allowWrites`, `writeConfirmation`, `folderScope` fields
- Added 4 new MCP tools: `refresh_snapshot`, `create_secret`, `update_secret`, `delete_secret`
- Added profile-driven folder scoping to ALL MCP tools (read + write). `im-aware` profile restricts to Infrastructure folder.
- Added `ToolAnnotations` (`destructiveHint`, `readOnlyHint`) to all MCP tools
- Created PAI skill (`~/.config/pai/Skills/vaultwarden-secrets/SKILL.md`) for cross-session discoverability
- Scrubbed git history with BFG — removed fake test passwords that ggshield flagged
- Hardened `.gitignore` — added `.env`, `.master-key`, `snapshot.enc`
- Set up global ggshield protection: pre-commit + pre-push hooks in `~/.config/git/hooks/` for ALL repos
- Created GitHub Actions CI workflow for server-side secret scanning
- Updated server `.env` on LXC 214 with `SECURITY_PROFILE=im-aware` and `API_FOLDERS_CLAUDE=Infrastructure`
- Bumped version to `0.6.0`

## Key Decisions
- **Profile-driven scoping over env vars:** `SecurityProfile.folderScope` is the single source of truth for MCP access control, replacing scattered `API_FOLDERS_*` env vars
- **Infrastructure folder only:** All MCP reads and writes scoped to Infrastructure folder. New secrets auto-placed there.
- **Destructive hints for write ops:** `update_secret` and `delete_secret` use MCP `destructiveHint: true`; `create_secret` does not
- **BFG for history rewrite:** Force-pushed feature branch to scrub test fixture passwords from git history. Necessary for going public.
- **Global ggshield:** Added to `~/.config/git/hooks/` (via `core.hooksPath`) so every repo on the machine is protected

## Files Changed
- `server/profiles.ts` — Added `allowWrites`, `writeConfirmation`, `folderScope` to SecurityProfile interface + all 4 profiles
- `server/mcp.ts` — Major rewrite: profile-based folder scoping, 4 new write tools, tool annotations, version 0.6.0
- `deploy/systemd/vw-snapshot.service` — Fixed User=root, correct bun path
- `snapshot.test.ts` — Replaced realistic test passwords with `FAKE_TEST_VALUE`
- `.gitignore` — Added `.env`, `.master-key`, `snapshot.enc`
- `.github/workflows/security.yml` — NEW: GitGuardian CI scanning
- `~/.config/git/hooks/pre-commit` — Added ggshield scanning (global)
- `~/.config/git/hooks/pre-push` — NEW: ggshield pre-push scanning (global)
- `~/.config/pai/Skills/vaultwarden-secrets/SKILL.md` — NEW: PAI skill for cross-session usage

## Next Session
- **Deploy to LXC 214** — git clone from GitHub, backup current setup, test, swap
- **MCP write operations:** Not yet tested end-to-end on the server (needs deploy first)
- **GitHub secret scanning:** Will auto-enable when repo goes public
- **Secure Notes support** in `secret` CLI (existing idea)
- **LiteLLM integration** — register MCP through LiteLLM gateway
