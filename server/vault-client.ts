/**
 * Vault Client — Pure functions for BW item manipulation + CLI wrappers.
 *
 * Pure functions (buildCreateTemplate, mergeUpdateFields) contain all the
 * data-shaping logic and are directly testable without mocking.
 * CLI wrappers (bwCreateItem, bwGetItem, bwEditItem, bwDeleteItem) are thin
 * shells over `bw` commands — tested via integration on the live server.
 *
 * @module server/vault-client
 */

import { $ } from 'bun';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomFieldInput {
  name: string;
  value: string;
  /** 0 = text (default), 1 = hidden */
  type?: number;
}

export interface CreateItemParams {
  name: string;
  /** 1 = login (default), 2 = secure note */
  type?: number;
  folderId: string;
  username?: string;
  password?: string;
  uri?: string;
  notes?: string;
  fields?: CustomFieldInput[];
}

export interface UpdateItemParams {
  username?: string;
  password?: string;
  uri?: string;
  notes?: string;
  fields?: CustomFieldInput[];
  /** 'merge' (default): update existing fields by name, append new ones.
   *  'replace': overwrite all custom fields. */
  fieldStrategy?: 'merge' | 'replace';
}

interface BwField {
  name: string;
  value: string;
  type: number;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Build a BW CLI item template for creation.
 *
 * Type 1 (login) includes a `login` block with username/password/uris.
 * Type 2 (secure note) includes a `secureNote` block and omits `login`
 * entirely — BW CLI silently ignores login fields on Secure Notes.
 */
export function buildCreateTemplate(params: CreateItemParams): Record<string, unknown> {
  const itemType = params.type ?? 1;

  const item: Record<string, unknown> = {
    type: itemType,
    name: params.name,
    folderId: params.folderId,
    notes: params.notes || null,
  };

  if (itemType === 1) {
    item.login = {
      username: params.username || null,
      password: params.password || null,
      uris: params.uri ? [{ match: null, uri: params.uri }] : [],
    };
  } else if (itemType === 2) {
    item.secureNote = { type: 0 };
  }

  const fields = params.fields?.map(f => ({
    name: f.name,
    value: f.value,
    type: f.type ?? 0,
  }));
  if (fields && fields.length > 0) {
    item.fields = fields;
  }

  return item;
}

/**
 * Merge update params into an existing BW item.
 *
 * Login fields are updated independently (setting username doesn't clobber
 * password). Custom fields use the chosen strategy:
 * - `merge` (default): match existing fields by name and update their value;
 *   append any new fields not already present.
 * - `replace`: overwrite the entire fields array.
 */
export function mergeUpdateFields(
  fullItem: Record<string, any>,
  params: UpdateItemParams,
): Record<string, any> {
  const result = structuredClone(fullItem);

  // Login field updates — preserve existing login block
  if (params.username !== undefined || params.password !== undefined || params.uri !== undefined) {
    result.login = { ...result.login };
    if (params.username !== undefined) result.login.username = params.username;
    if (params.password !== undefined) result.login.password = params.password;
    if (params.uri !== undefined) {
      result.login.uris = [{ match: null, uri: params.uri }];
    }
  }

  if (params.notes !== undefined) result.notes = params.notes;

  // Custom fields
  if (params.fields && params.fields.length > 0) {
    const strategy = params.fieldStrategy ?? 'merge';
    const incoming: BwField[] = params.fields.map(f => ({
      name: f.name,
      value: f.value,
      type: f.type ?? 0,
    }));

    if (strategy === 'replace') {
      result.fields = incoming;
    } else {
      const existing: BwField[] = result.fields ? [...result.fields] : [];
      for (const nf of incoming) {
        const idx = existing.findIndex(e => e.name === nf.name);
        if (idx >= 0) {
          existing[idx] = nf;
        } else {
          existing.push(nf);
        }
      }
      result.fields = existing;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

export async function bwCreateItem(session: string, template: Record<string, unknown>): Promise<any> {
  const encoded = Buffer.from(JSON.stringify(template)).toString('base64');
  const result = await $`BW_SESSION=${session} bw create item ${encoded}`.quiet();
  return JSON.parse(result.text());
}

export async function bwGetItem(session: string, itemId: string): Promise<any> {
  const result = await $`BW_SESSION=${session} bw get item ${itemId}`.quiet();
  return JSON.parse(result.text());
}

export async function bwEditItem(session: string, itemId: string, fullItem: Record<string, any>): Promise<any> {
  const encoded = Buffer.from(JSON.stringify(fullItem)).toString('base64');
  const result = await $`BW_SESSION=${session} bw edit item ${itemId} ${encoded}`.quiet();
  return JSON.parse(result.text());
}

export async function bwDeleteItem(session: string, itemId: string): Promise<void> {
  await $`BW_SESSION=${session} bw delete item ${itemId}`.quiet();
}
