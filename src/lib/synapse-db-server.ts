/**
 * synapse-db-server.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Background server sync for Synapse chat data.
 *
 * This module is entirely fire-and-forget. It NEVER affects local UI or state.
 * If the server is down, nothing breaks — data is already safe in IndexedDB.
 *
 * Used for:
 *  • Backing up conversation data to the server
 *  • Sending a final beacon on page visibility change
 */

import {
  db,
  getMessages,
  upsertServerConversation,
  type Conversation,
  type StoredMessage,
} from './synapse-db';
import { SYNAPSE_API_BASE } from './api-config';
import { getIdToken } from './auth';

const API_BASE = SYNAPSE_API_BASE;
const TIMEOUT = 6_000;

// Server-side history belongs to a VERIFIED Google account. Anonymous visitors
// have no server owner, so every sync call below is a no-op for them — their
// chats stay in IndexedDB only. `null` ⇒ not signed in ⇒ skip the request.
function authHeaders(base: Record<string, string> = {}): Record<string, string> | null {
  const token = getIdToken();
  if (!token) return null;
  return { ...base, Authorization: `Bearer ${token}` };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
}

// ─── Server push (background, non-blocking) ───────────────────────────────────

/**
 * Push a conversation + messages to the server.
 * Fire-and-forget: errors are silently logged.
 */
/**
 * Must match `ConversationSaveRequest.messages` max_length in inference/main.py.
 *
 * The client sent the whole conversation and the server rejects anything past
 * this with a 422, which the old `.catch(() => {})` swallowed — so a chat that
 * crossed 100 messages silently stopped being backed up, forever, while the UI
 * showed nothing at all. Sending the most recent 100 keeps the server copy a
 * rolling window of the live conversation instead of a snapshot frozen at the
 * moment it got too long. IndexedDB still holds every message; the server copy
 * is the cross-device mirror, and a recent mirror beats a stale complete one.
 *
 * The better fix is raising the bound on both sides at once. Doing that means
 * a backend deploy, so it has to be a matched pair, not a client-side edit.
 */
const SERVER_MAX_MESSAGES = 100;

/** Logged once per session — a sync that quietly gives up is the thing being fixed. */
let warnedAboutTruncation = false;

export function pushToServer(conv: Conversation, messages: StoredMessage[]): void {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  if (!headers) return; // anonymous → local-only, nothing to sync

  const sent = messages.slice(-SERVER_MAX_MESSAGES);
  if (sent.length < messages.length && !warnedAboutTruncation) {
    warnedAboutTruncation = true;
    console.warn(
      `[synapse-sync] Conversation has ${messages.length} messages; the server accepts ` +
        `${SERVER_MAX_MESSAGES}. Syncing the most recent ${SERVER_MAX_MESSAGES}. ` +
        `Nothing is lost locally.`
    );
  }

  const payload: ServerConversation = {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: sent.map((m) => ({
      id: m.msgId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .then((res) => {
      // A rejected sync used to be indistinguishable from a successful one.
      // Still non-fatal — IndexedDB is the source of truth and the next message
      // retries — but it should not be invisible while it happens.
      if (!res.ok) {
        console.warn(`[synapse-sync] Server refused the conversation upsert: HTTP ${res.status}`);
      }
    })
    .catch(() => {}) // network/abort — the next message retries
    .finally(() => clearTimeout(timer));
}

/**
 * Push conversation data via sendBeacon (for visibilitychange / unload).
 * Uses text/plain to avoid CORS preflight.
 */
export function beaconSave(conv: Conversation, messages: StoredMessage[]): void {
  const token = getIdToken();
  if (!token) return; // anonymous → nothing to persist server-side
  const payload = JSON.stringify({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    // sendBeacon can't set headers → carry the ID token in the body; the backend
    // verifies it exactly like the Authorization header on the other endpoints.
    idToken: token,
    messages: messages.slice(-100).map((m) => ({
      id: m.msgId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  });

  navigator.sendBeacon(
    `${API_BASE}/api/conversations/beacon`,
    new Blob([payload], { type: 'text/plain' })
  );
}

/**
 * Rename a conversation on the server.
 */
export function serverRename(convId: string, title: string): void {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  if (!headers) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  fetch(`${API_BASE}/api/conversations/${convId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ title }),
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/**
 * Delete a conversation on the server.
 */
export function serverDelete(convId: string): void {
  const headers = authHeaders();
  if (!headers) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  fetch(`${API_BASE}/api/conversations/${convId}`, {
    method: 'DELETE',
    headers,
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

// ─── Server → local pull (cross-device sync) ──────────────────────────────────

interface ServerConvSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

async function authedGet(path: string): Promise<Response | null> {
  const headers = authHeaders();
  if (!headers) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(`${API_BASE}${path}`, { headers, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the signed-in account's conversations DOWN from the server into local
 * Dexie — the missing half of cross-device sync. For each server conversation
 * that is absent locally OR newer than the local copy, fetch it in full and
 * upsert it. Locally-newer conversations are left untouched (the push path syncs
 * those up). Anonymous → no-op. Returns true if anything local changed, so the
 * caller can refresh the UI.
 */
export async function pullFromServer(): Promise<boolean> {
  const listRes = await authedGet('/api/conversations');
  if (!listRes || !listRes.ok) return false;

  let serverConvs: ServerConvSummary[];
  try {
    serverConvs = (await listRes.json()).conversations ?? [];
  } catch {
    return false;
  }
  if (serverConvs.length === 0) return false;

  const local = await db.conversations.toArray();
  const localById = new Map(local.map((c) => [c.id, c]));

  let changed = false;
  for (const sc of serverConvs) {
    const lc = localById.get(sc.id);
    if (lc && sc.updatedAt <= lc.updatedAt) continue; // local is same-or-newer → keep it

    const fullRes = await authedGet(`/api/conversations/${sc.id}`);
    if (!fullRes || !fullRes.ok) continue;
    try {
      const full = await fullRes.json();
      const messages = (full.messages ?? []).map(
        (m: { id: string; role: 'user' | 'assistant'; content: string; timestamp: number }) => ({
          msgId: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })
      );
      if (messages.length === 0) continue;
      await upsertServerConversation(
        { id: full.id, title: full.title, createdAt: full.createdAt, updatedAt: full.updatedAt },
        messages
      );
      changed = true;
    } catch {
      // skip this conversation, keep going
    }
  }
  return changed;
}

// ─── Visibility change handler ────────────────────────────────────────────────

/**
 * Setup visibilitychange listener that sends a beacon when user
 * switches tabs or minimizes. More reliable than beforeunload.
 *
 * Call once from the component's onMount.
 * Returns cleanup function for onDestroy.
 */
export function setupVisibilitySync(getCurrentConvId: () => string): () => void {
  const handler = async () => {
    if (document.visibilityState !== 'hidden') return;

    const convId = getCurrentConvId();
    if (!convId) return;

    try {
      const conv = await db.conversations.get(convId);
      if (!conv) return;
      const msgs = await getMessages(convId);
      if (msgs.length === 0) return;

      beaconSave(conv, msgs);
    } catch {
      // Best-effort, don't throw
    }
  };

  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
