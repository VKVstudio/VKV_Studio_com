/**
 * synapse-db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Chat storage layer using Dexie.js (IndexedDB wrapper).
 *
 * Architecture:
 *   Dexie → SINGLE source of truth (local, instant, survives Ctrl+R)
 *   Server → background sync only (fire-and-forget)
 *
 * Key design decisions:
 *   • NO debouncing — saves happen immediately
 *   • NO save locks — Dexie handles transactions automatically
 *   • NO beforeunload hacks — data is already in DB before user leaves
 *   • Normalized tables: conversations + messages (not one giant blob)
 *   • liveQuery for reactive UI updates
 */

import Dexie, { type EntityTable } from 'dexie';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Which identity on THIS browser profile the conversation belongs to: a
   * Google `sub`, or ANON_OWNER for chats held without signing in.
   *
   * IndexedDB is one store per browser profile, so before this field existed a
   * shared machine leaked outright: person B opened the terminal and person A's
   * conversation list rendered, with the newest transcript on screen, before
   * any authentication ran — and signing out never cleared it, because
   * `signOut()` only drops the in-memory token and sessionStorage. Worse, on
   * sign-in every local conversation was pushed to the server under whoever had
   * just authenticated, and the backend's ownership guard only rejects an id
   * ALREADY claimed by someone else, so a fresh id was adopted by the first
   * pusher. A stranger's chats became durably retrievable from B's account.
   *
   * Optional only for records written before v3; the v3 upgrade backfills them.
   */
  owner?: string;
}

/** Owner value for conversations held without signing in. */
export const ANON_OWNER = 'anon';

/**
 * The identity local reads and writes are scoped to. Deliberately defaults to
 * ANON_OWNER: if a caller forgets to set it, the failure mode is seeing only
 * anonymous chats, never someone else's account.
 */
let currentOwner: string = ANON_OWNER;

/** Set by the UI on mount and on every auth change. Pass null for signed-out. */
export function setLocalChatOwner(owner: string | null | undefined): void {
  currentOwner = owner || ANON_OWNER;
}

export function getLocalChatOwner(): string {
  return currentOwner;
}

/**
 * Conversation ids created during THIS page session.
 *
 * Adopting anonymous chats into an account on sign-in is a real feature — try
 * it signed-out, sign in, keep your history — and it is worth preserving. What
 * it must not do is adopt chats a DIFFERENT person left in this browser
 * earlier. Session scope is the line between the two: chats you created in the
 * visit where you signed in are yours; chats already on disk when the page
 * loaded are not assumed to be.
 */
const createdThisSession = new Set<string>();

export function wasCreatedThisSession(id: string): boolean {
  return createdThisSession.has(id);
}

/**
 * Marker proving THIS TAB has already run the purge. `sessionStorage` dies with
 * the tab, which is most of the boundary the owner asked for — "close the
 * browser and it is gone, sign in and it is kept".
 */
const BROWSER_SESSION_MARKER = 'synapse:browser-session';

/**
 * Heartbeat proving some tab was alive very recently. This exists because
 * `sessionStorage` alone got it WRONG, and the way it was wrong destroyed data:
 * sessionStorage is per-TAB while IndexedDB is per-ORIGIN, so opening a second
 * tab looked like a fresh browser session and deleted the anonymous
 * conversation the FIRST tab was still writing into. Same for a middle-click
 * into a new tab, or a link opened from the Lab.
 *
 * localStorage is shared across tabs and survives a reload, so a recent
 * timestamp is proof that the browser never actually closed. The purge now
 * needs BOTH signals to agree: this tab has not purged yet AND nobody has been
 * here lately.
 */
const LAST_SEEN_KEY = 'synapse:last-seen';

/**
 * How stale the heartbeat must be before we accept that the browser closed.
 *
 * A live tab refreshes it on an interval well under this, so a second tab
 * always finds it fresh. The cost of the window is that closing and reopening
 * the browser inside it keeps the history — which is the harmless direction to
 * be wrong in. Deleting a conversation someone is still typing into is not.
 */
const SESSION_GAP_MS = 90_000;

/** Called by the UI on mount and on an interval, so other tabs can see us. */
export function touchBrowserSession(): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
  } catch {
    /* storage disabled — purge then fails closed, which is the safe direction */
  }
}

/**
 * Delete anonymous conversations left over from a PREVIOUS browser session.
 *
 * Signing in is what makes history durable. Without it, chats are held in this
 * browser only — and holding a stranger's transcripts on a shared machine for
 * days is not a feature, it is a leak with a friendly name. So an anonymous
 * history now lasts exactly as long as the browser stays open: F5 keeps it,
 * closing the browser clears it, signing in preserves it (the chat is re-tagged
 * to that account and pushed to the server, so it stops being anonymous).
 *
 * Runs at most once per tab, only when no other tab has been alive recently,
 * and only deletes rows owned by ANON_OWNER — an account's chats are never
 * touched here.
 *
 * If either storage is unavailable (private modes, storage disabled) this does
 * NOTHING rather than guessing. Failing to delete is a privacy shortfall;
 * deleting because we could not tell would be data loss, and between the two
 * the destructive mistake is the one worth refusing.
 */
export async function purgeStaleAnonConversations(): Promise<number> {
  let firstVisitThisTab: boolean;
  let lastSeen: number;
  try {
    firstVisitThisTab = sessionStorage.getItem(BROWSER_SESSION_MARKER) === null;
    sessionStorage.setItem(BROWSER_SESSION_MARKER, '1');
    lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
  if (!firstVisitThisTab) return 0;

  // Another tab is open right now, or the browser was closed only moments ago.
  // Either way this is not a fresh browser session, and the anonymous history
  // belongs to whoever is still using it. Refresh the heartbeat and leave.
  if (lastSeen && Date.now() - lastSeen < SESSION_GAP_MS) {
    touchBrowserSession();
    return 0;
  }
  touchBrowserSession();

  const stale = await db.conversations.where('owner').equals(ANON_OWNER).toArray();
  if (stale.length === 0) return 0;

  const ids = stale.map((c) => c.id);
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('convId').anyOf(ids).delete();
    await db.conversations.where('id').anyOf(ids).delete();
  });
  return ids.length;
}

/**
 * Delete every conversation and message belonging to one identity on THIS
 * browser profile.
 *
 * Signing out used to leave them on disk forever. `signOut()` (auth.ts) drops
 * the token, and the terminal clears the screen, but nothing removed the rows:
 * `purgeStaleAnonConversations` above deliberately touches only ANON_OWNER, so
 * an account's transcripts survived sign-out, browser close and every later
 * session. On a machine that is not yours — a demo at a client's office, a
 * borrowed laptop — the next person opens devtools, reads IndexedDB and gets
 * the full text of every chat plus the Google `sub` they belonged to. The
 * owner filter on `listConversations` is a display filter, not access control.
 *
 * Safe to delete because the signed-in copy is not the durable one: the server
 * holds it (chat_storage.py) and `pullFromServer()` restores everything on the
 * next sign-in. The one case that does lose data is a conversation created
 * while the backend was unreachable and never synced — which is why the caller
 * flushes the open conversation before calling this, and why this is invoked
 * only on an explicit sign-out rather than on a timer.
 */
export async function purgeOwnerConversations(owner: string): Promise<number> {
  if (!owner || owner === ANON_OWNER) return 0;
  const mine = await db.conversations.where('owner').equals(owner).toArray();
  if (mine.length === 0) return 0;
  const ids = mine.map((c) => c.id);
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('convId').anyOf(ids).delete();
    await db.conversations.where('id').anyOf(ids).delete();
  });
  return ids.length;
}

export interface StoredMessage {
  autoId?: number; // Auto-increment primary key
  convId: string; // Foreign key → conversations.id
  msgId: string; // Application-level message ID (for keyed #each)
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ─── Database Definition ──────────────────────────────────────────────────────

const db = new Dexie('SynapseChat') as Dexie & {
  conversations: EntityTable<Conversation, 'id'>;
  messages: EntityTable<StoredMessage, 'autoId'>;
};

// Version history — Dexie needs all versions for migration
db.version(1).stores({
  conversations: 'id, updatedAt',
  messages: '++autoId, convId, msgId',
});

// Version 2: added compound index [convId+msgId]
db.version(2).stores({
  conversations: 'id, updatedAt',
  messages: '++autoId, convId, msgId, [convId+msgId]',
});

// Version 3: per-identity scoping (see Conversation.owner).
//
// Existing rows are backfilled to ANON_OWNER rather than to any account,
// because at upgrade time nobody knows who wrote them — and guessing an owner
// is exactly the mistake this version exists to stop. A signed-in user loses
// nothing by that: their history also lives on the server, and signing in pulls
// it straight back. What they DO gain is that those legacy rows can no longer
// be silently adopted into someone else's account, since adoption now also
// requires the conversation to have been created in the current session.
db.version(3)
  .stores({
    conversations: 'id, updatedAt, owner, [owner+updatedAt]',
    messages: '++autoId, convId, msgId, [convId+msgId]',
  })
  .upgrade((tx) =>
    tx
      .table('conversations')
      .toCollection()
      .modify((c: Conversation) => {
        if (!c.owner) c.owner = ANON_OWNER;
      })
  );

export { db };

// ─── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a new empty conversation.
 * Returns the created conversation.
 */
export async function createConversation(title = 'New Chat'): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    owner: currentOwner,
  };
  await db.conversations.add(conv);
  createdThisSession.add(conv.id);
  return conv;
}

/**
 * Add a message to a conversation. Saves instantly to IndexedDB.
 * Also touches conversation.updatedAt.
 */
export async function addMessage(
  convId: string,
  msg: { msgId: string; role: 'user' | 'assistant'; content: string; timestamp: number }
): Promise<void> {
  await db.transaction('rw', [db.messages, db.conversations], async () => {
    await db.messages.add({
      convId,
      msgId: msg.msgId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    });
    await db.conversations.update(convId, { updatedAt: Date.now() });
  });
}

/**
 * Update a message's content (used during streaming).
 * Finds by convId + msgId, updates content.
 */
export async function updateMessageContent(
  convId: string,
  msgId: string,
  content: string
): Promise<void> {
  const existing = await db.messages.where({ convId, msgId }).first();
  if (existing?.autoId != null) {
    await db.messages.update(existing.autoId, { content });
  }
}

/**
 * Get all messages for a conversation, ordered by autoId (insertion order).
 */
export async function getMessages(convId: string): Promise<StoredMessage[]> {
  return db.messages.where('convId').equals(convId).sortBy('autoId');
}

/**
 * Get a single conversation's metadata (without messages).
 */
export async function getConversation(id: string): Promise<Conversation | undefined> {
  return db.conversations.get(id);
}

/**
 * List the CURRENT identity's conversations, newest first.
 *
 * Scoped, not global. This is the read that used to render a previous
 * visitor's transcript to whoever opened the terminal next on a shared
 * browser — it ran on mount, before any authentication, against a store that
 * held everyone's chats together.
 */
export async function listConversations(): Promise<Conversation[]> {
  const rows = await db.conversations.where('owner').equals(currentOwner).toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Hand this session's anonymous conversations to a newly signed-in account.
 *
 * Returns the adopted conversations so the caller can push them to the server.
 * Only chats created in THIS page session qualify: anything already on disk
 * when the page loaded may belong to whoever used this browser last, and
 * uploading a stranger's transcript into your account is not a sync feature.
 *
 * Call AFTER setLocalChatOwner(sub) — the re-tag targets that owner.
 */
export async function adoptAnonConversations(): Promise<Conversation[]> {
  if (currentOwner === ANON_OWNER) return [];
  const candidates = (await db.conversations.where('owner').equals(ANON_OWNER).toArray()).filter(
    (c) => createdThisSession.has(c.id)
  );
  if (candidates.length === 0) return [];
  await db.conversations
    .where('id')
    .anyOf(candidates.map((c) => c.id))
    .modify({ owner: currentOwner });
  return candidates.map((c) => ({ ...c, owner: currentOwner }));
}

/**
 * Rename a conversation.
 */
export async function renameConversation(id: string, title: string): Promise<void> {
  await db.conversations.update(id, { title, updatedAt: Date.now() });
}

/**
 * Delete a conversation and all its messages.
 */
export async function deleteConversation(id: string): Promise<void> {
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('convId').equals(id).delete();
    await db.conversations.delete(id);
  });
}

/**
 * Upsert a conversation pulled from the server into local Dexie (cross-device
 * sync). The server copy is authoritative for THIS conversation — its messages
 * replace the local set — so callers must only pass conversations that are
 * server-newer or server-only (never clobber a locally-newer conversation).
 */
export async function upsertServerConversation(
  conv: { id: string; title: string; createdAt: number; updatedAt: number },
  messages: Array<{ msgId: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
): Promise<void> {
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    // Owned by whoever is signed in, since the server only ever returns the
    // authenticated account's own conversations.
    await db.conversations.put({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      owner: currentOwner,
    });
    await db.messages.where('convId').equals(conv.id).delete();
    for (const m of messages) {
      await db.messages.add({
        convId: conv.id,
        msgId: m.msgId,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      });
    }
  });
}

/**
 * Generate a title from the first user message.
 */
export function makeTitleFromMessages(msgs: StoredMessage[]): string {
  const first = msgs.find((m) => m.role === 'user');
  if (!first) return 'New Chat';
  const text = first.content.replace(/^🎤\s*/, '').trim();
  return text.length > 40 ? text.slice(0, 40) + '…' : text || 'New Chat';
}

/**
 * Auto-title: if conversation is still "New Chat" and has user messages,
 * derive a title from the first user message.
 */
export async function autoTitle(convId: string): Promise<void> {
  const conv = await db.conversations.get(convId);
  if (!conv || conv.title !== 'New Chat') return;
  const msgs = await getMessages(convId);
  const title = makeTitleFromMessages(msgs);
  if (title !== 'New Chat') {
    await db.conversations.update(convId, { title, updatedAt: Date.now() });
  }
}

// ─── Migration from old synapse-storage ───────────────────────────────────────

const LEGACY_LS_KEY = 'synapse-chat-history';
const OLD_IDB_NAME = 'synapse-db';

/**
 * Migrate data from old storage systems:
 *  1. localStorage (very old)
 *  2. old raw IndexedDB "synapse-db" (previous implementation)
 *
 * Runs once, then sets a flag so it never runs again.
 */
export async function migrateOldData(): Promise<void> {
  if (typeof window === 'undefined') return;
  const MIGRATED_FLAG = 'synapse-v3-migrated';
  if (localStorage.getItem(MIGRATED_FLAG)) return;

  try {
    // 1. Migrate from localStorage
    const lsData = localStorage.getItem(LEGACY_LS_KEY);
    if (lsData) {
      const oldConvs = JSON.parse(lsData) as Array<{
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
      }>;
      for (const old of oldConvs) {
        const exists = await db.conversations.get(old.id);
        if (!exists) {
          await db.conversations.add({
            id: old.id,
            title: old.title,
            createdAt: old.createdAt,
            updatedAt: old.updatedAt,
            // Required. Every read is `where('owner').equals(currentOwner)`, so
            // a row written without one is invisible to every identity there
            // is — the migration imported the history and hid it in the same
            // breath. ANON_OWNER is the same answer the v3 upgrade gives to
            // the same question (see its comment above): at import time nobody
            // knows who wrote these, and guessing is the mistake that scoping
            // exists to prevent.
            owner: ANON_OWNER,
          });
          for (const msg of old.messages) {
            await db.messages.add({
              convId: old.id,
              msgId: msg.id,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
            });
          }
        }
      }
      localStorage.removeItem(LEGACY_LS_KEY);
    }

    // 2. Migrate from old IndexedDB (synapse-db)
    await migrateFromOldIDB();
  } catch (err) {
    console.warn('[synapse-db] Migration error (non-fatal):', err);
  }

  localStorage.setItem(MIGRATED_FLAG, '1');
}

/**
 * Read conversations from the old "synapse-db" IndexedDB and import them.
 */
async function migrateFromOldIDB(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }

    const req = indexedDB.open(OLD_IDB_NAME, 1);
    req.onerror = () => resolve();
    req.onupgradeneeded = () => {
      // DB didn't exist, no data to migrate
      req.transaction?.abort();
      resolve();
    };
    req.onsuccess = async () => {
      const oldDb = req.result;
      try {
        if (!oldDb.objectStoreNames.contains('conversations')) {
          oldDb.close();
          resolve();
          return;
        }
        const tx = oldDb.transaction('conversations', 'readonly');
        const store = tx.objectStore('conversations');
        const getAll = store.getAll();

        getAll.onsuccess = async () => {
          const oldConvs = getAll.result as Array<{
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
          }>;

          for (const old of oldConvs) {
            const exists = await db.conversations.get(old.id);
            if (!exists && old.messages?.length > 0) {
              await db.conversations.add({
                id: old.id,
                title: old.title,
                createdAt: old.createdAt,
                updatedAt: old.updatedAt,
                owner: ANON_OWNER, // same reason as the localStorage path above
              });
              for (const msg of old.messages) {
                await db.messages.add({
                  convId: old.id,
                  msgId: msg.id,
                  role: msg.role,
                  content: msg.content,
                  timestamp: msg.timestamp,
                });
              }
            }
          }
          oldDb.close();
          resolve();
        };
        getAll.onerror = () => {
          oldDb.close();
          resolve();
        };
      } catch {
        oldDb.close();
        resolve();
      }
    };
  });
}
