/**
 * Move homelab items to the Infrastructure folder in Vaultwarden.
 * Also detects and reports duplicates.
 *
 * Usage: bun scripts/move-to-infra.ts [--dry-run]
 */

import { $ } from 'bun';
import { getVaultSession } from '../keychain';
import { getActiveVault } from '../index';

const INFRA_FOLDER_ID = 'a0c9b448-1a48-45fd-8c5a-6309ea710fdf';
const DRY_RUN = process.argv.includes('--dry-run');

// Items to move into Infrastructure
const ITEMS_TO_MOVE = new Set([
  'Grafana SA', 'Grafana',
  'PBS Admin', 'PiHole', 'local PiHole', 'pihole01', 'pihole01.rtech.local', 'pihole03.rodaddy.live',
  'Plex', 'Docker', 'portainer',
  'proxmox02', 'proxmox06',
  'truenas01', 'truenas02',
  'freenas',
  'UniFi', 'ubiquiti',
  'homeassistant.local',
  'opnsense.rodaddy.live',
  'LiteLLM',
  'open webUI', 'chat.rodaddy.live', 'vaultwarden.rodaddy.live',
  'ClouDNS', 'notifiarr.com',
  'agent-ai', 'Arm Pro Internet',
  'rico/GEMINI_API_KEY', 'rico/GOOGLE_APPLICATION_CREDENTIALS', 'rico/PAI_PRIVATE',
  'n8n local', 'n8n.rodaddy.live', 'rodaddy.app.n8n.cloud',
  'lidarr.rodaddy.live', 'prowlarr.rodaddy.live',
  'radarr.rodaddy.live', 'sonarr.rodaddy.live', 'pbs.rodaddy.live',
]);

async function main() {
  const vaultId = await getActiveVault();
  const session = await getVaultSession(vaultId);
  if (!session) {
    console.error('No vault session. Run: secret unlock');
    process.exit(1);
  }

  console.log(DRY_RUN ? '🔍 DRY RUN — no changes will be made\n' : '');

  // Get all items
  const itemsJson = await $`BW_SESSION=${session} bw list items`.quiet();
  const items: any[] = JSON.parse(itemsJson.stdout.toString());

  // --- Step 1: Detect duplicates ---
  const nameCount = new Map<string, any[]>();
  for (const item of items) {
    const existing = nameCount.get(item.name) || [];
    existing.push(item);
    nameCount.set(item.name, existing);
  }

  const dupes = [...nameCount.entries()].filter(([, v]) => v.length > 1 && ITEMS_TO_MOVE.has(v[0].name));
  if (dupes.length > 0) {
    console.log('⚠  Duplicates detected (in our move list):');
    for (const [name, copies] of dupes) {
      console.log(`  ${name} — ${copies.length} copies`);
      for (const copy of copies) {
        const hasPassword = copy.login?.password ? '✓ password' : '✗ no password';
        const hasUsername = copy.login?.username ? '✓ username' : '✗ no username';
        const hasUri = copy.login?.uris?.length > 0 ? '✓ uri' : '✗ no uri';
        const hasNotes = copy.notes ? '✓ notes' : '✗ no notes';
        const fields = copy.fields?.length || 0;
        console.log(`    [${copy.id.slice(0, 8)}] folder=${copy.folderId?.slice(0, 8) || 'none'} | ${hasPassword} | ${hasUsername} | ${hasUri} | ${hasNotes} | ${fields} custom fields`);
      }
    }
    console.log('');
  }

  // --- Step 2: Move items to Infrastructure ---
  const toMove = items.filter(i => ITEMS_TO_MOVE.has(i.name) && i.folderId !== INFRA_FOLDER_ID);

  // For duplicates, pick the one with the most data
  const seen = new Set<string>();
  const moveList: any[] = [];

  for (const item of toMove) {
    // For dupes, we'll move all copies to Infrastructure (can clean up later)
    moveList.push(item);
  }

  console.log(`Moving ${moveList.length} items to Infrastructure folder...`);
  console.log('');

  let moved = 0;
  let failed = 0;

  for (const item of moveList) {
    if (DRY_RUN) {
      console.log(`  [dry-run] ${item.name}`);
      moved++;
      continue;
    }

    item.folderId = INFRA_FOLDER_ID;
    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');

    try {
      await $`BW_SESSION=${session} bw edit item ${item.id} ${encoded}`.quiet();
      console.log(`  ✓ ${item.name}`);
      moved++;
    } catch (error: any) {
      console.log(`  ✗ ${item.name} — ${error.message || 'failed'}`);
      failed++;
    }
  }

  // --- Step 3: Summary ---
  console.log('');

  // Count total in Infrastructure after move
  const alreadyInInfra = items.filter(i => i.folderId === INFRA_FOLDER_ID).length;
  console.log(`Done: ${moved} moved, ${failed} failed`);
  console.log(`Infrastructure folder: ${alreadyInInfra + moved} items total (was ${alreadyInInfra})`);
}

main().catch(console.error);
