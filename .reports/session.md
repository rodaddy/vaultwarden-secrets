# Session Summary

**Date:** 2026-02-06
**Project:** vaultwarden-secrets

## What Got Done
- Added 5 new API endpoints to match CLI capabilities: `/secrets`, `/secrets/search`, `/secret/:name/fields`, `/cache/stats`, `/cache/clear`
- Built per-client folder scoping system (`API_FOLDERS_<CLIENT>` env vars) so each bearer token can be restricted to specific VW folders
- Cleaned up 6 duplicate VW items (freenas x3, truenas01 x2, truenas01.rodaddy.live)
- Moved 39 homelab items into the `Infrastructure` folder (now 54 items total)
- Verified all security middleware still enforced on new endpoints (64 server tests pass)
- End-to-end tested: scoped token sees 54 items, full token sees 1,070

## Key Decisions
- **Two-token model for CC access:** Scoped token (default, auto-use) restricted to Infrastructure folder; full-access token available but requires CC permission prompt each use
- **Folder scoping at server level:** Bearer auth middleware carries `clientId`, route handlers call `folderScope.isAllowed()` / `filterItems()`. Items outside scope return 404 (indistinguishable from not existing)
- **Cache clear refreshes folder scope:** `POST /cache/clear` also calls `folderScope.refresh()` so new items/folder moves are picked up without server restart
- **Touch ID gating (Option B) deferred:** Would be ideal but biometric-auth binary doesn't support this flow yet

## Files Changed
- `server/main.ts` — Added 5 endpoints, folder scope initialization, per-route scope filtering
- `server/utils/folder-scope.ts` — New: FolderScope class with isAllowed/filterItems, loadFolderScopes from env
- `scripts/move-to-infra.ts` — One-time migration script for moving items to Infrastructure folder

## Next Session
- Deploy updated server to vault.rodaddy.live with real API tokens
- Set up CC environment with scoped token (`VAULT_TOKEN`) and full token (`VAULT_ADMIN_TOKEN`)
- Consider adding `secret folder-move` CLI command for easy ongoing item management
- Option B (Touch ID gating for full-access token) as future enhancement
