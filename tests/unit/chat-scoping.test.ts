/**
 * Guards per-identity scoping of local chat storage.
 *
 * These assertions read source, not behaviour, and that is deliberate. The
 * defect they guard is an ABSENCE — a missing filter, a missing owner stamp, a
 * missing clear on sign-out — and absence is invisible to a functional test:
 * every single-user session passes with or without any of it. It only surfaces
 * when a SECOND person uses the same browser profile, which no unit test with
 * one IndexedDB and one identity can stage. (There is no IndexedDB shim in this
 * project's node test environment either, so a real Dexie round-trip is not
 * available here.) Same reasoning, and same shape, as
 * inference/tests/test_admission_coverage.py.
 *
 * What actually went wrong: IndexedDB is one store per browser profile.
 * `listConversations()` returned all of it and ran on mount before any auth
 * check, so opening the terminal rendered the previous visitor's newest
 * transcript. `signOut()` never touched it. And on sign-in every local
 * conversation was pushed to the server under the account that had just
 * authenticated — durably, because the backend only rejects an id already
 * claimed by someone else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const DB = read('../../src/lib/synapse-db.ts');
const TERMINAL = read('../../src/components/ui/SynapseTerminal.svelte');

/** Body of a top-level `export async function name(` / `export function name(`. */
function fnBody(src: string, name: string): string {
  const marker = new RegExp(`export (?:async )?function ${name}\\b`);
  const m = marker.exec(src);
  if (!m) throw new Error(`no exported function ${name}`);
  const next = src.indexOf('\nexport ', m.index + 1);
  return src.slice(m.index, next === -1 ? src.length : next);
}

describe('local chat storage is scoped to an identity', () => {
  it('listConversations filters by owner instead of returning the whole store', () => {
    const body = fnBody(DB, 'listConversations');
    expect(body, 'must not read the table unfiltered').not.toMatch(/db\.conversations\.orderBy\(/);
    expect(body).toMatch(/where\('owner'\)/);
    expect(body).toMatch(/currentOwner/);
  });

  it('every new conversation is stamped with the current owner', () => {
    const body = fnBody(DB, 'createConversation');
    expect(body).toMatch(/owner:\s*currentOwner/);
  });

  it('conversations pulled from the server are stamped too', () => {
    const body = fnBody(DB, 'upsertServerConversation');
    expect(body).toMatch(/owner:\s*currentOwner/);
  });

  it('the owner defaults to anonymous, never to an account', () => {
    // If a caller forgets setLocalChatOwner, the safe failure is showing only
    // anonymous chats — not falling back to whoever signed in last.
    expect(DB).toMatch(/let currentOwner: string = ANON_OWNER/);
  });

  it('adoption is limited to conversations created in this session', () => {
    const body = fnBody(DB, 'adoptAnonConversations');
    expect(body).toMatch(/createdThisSession\.has/);
    expect(body, 'must only ever adopt anonymous chats').toMatch(/equals\(ANON_OWNER\)/);
  });
});

describe('the terminal applies the identity before reading storage', () => {
  it('sets the owner on mount', () => {
    expect(TERMINAL).toMatch(/setLocalChatOwner\(getProfile\(\)\?\.sub\)/);
  });

  it('re-applies it on every auth change, not only on sign-in', () => {
    // The old subscription was `if (isSignedIn()) syncOnSignIn()`, so signing
    // out did nothing at all and the previous account's chats stayed on screen.
    expect(TERMINAL).toMatch(/onAuthChange\(\(\) => \{\s*void applyIdentity\(\);/);
    expect(TERMINAL).toMatch(/async function applyIdentity/);
  });

  it('clears the open transcript when signing out', () => {
    const body = TERMINAL.slice(TERMINAL.indexOf('async function applyIdentity'));
    const upToNext = body.slice(0, body.indexOf('async function syncOnSignIn'));
    expect(upToNext).toMatch(/messages = \[\]/);
    expect(upToNext).toMatch(/currentConversationId = null/);
  });

  it('backs up only adopted chats, never the whole local store', () => {
    const start = TERMINAL.indexOf('async function backupLocalChatsToAccount');
    const body = TERMINAL.slice(start, TERMINAL.indexOf('\n  }', start));
    expect(body).toMatch(/adoptAnonConversations\(\)/);
    expect(body, 'listing everything is what leaked in the first place').not.toMatch(
      /dbListConversations\(\)/
    );
  });
});

describe("signing out takes the account's transcripts off this disk", () => {
  /**
   * The hole a security review found, 2026-08-25: `signOut()` cleared the
   * token, `applyIdentity()` cleared the screen, and
   * `purgeStaleAnonConversations()` only ever deletes ANON_OWNER rows — so an
   * account's chats stayed in IndexedDB through sign-out, browser close and
   * every later session. On a machine that is not yours, the next person opens
   * devtools and reads the lot, plus the Google `sub` they belong to. The owner
   * filter on the list query is a display filter, not access control.
   *
   * Same source-reading approach as the rest of this file, and for the same
   * reason: the defect is an absence, and there is no IndexedDB in this
   * environment to stage two identities against.
   */
  it('exposes a purge that removes BOTH the conversations and their messages', () => {
    const body = fnBody(DB, 'purgeOwnerConversations');
    expect(body).toMatch(/db\.conversations\.where\('owner'\)\.equals\(owner\)/);
    // A conversation row deleted without its messages leaves the transcript
    // itself readable — which is the entire content of the leak. Matched as a
    // whole delete CHAIN, not as `db.messages` anywhere in the body: the
    // transaction's scope array names both tables, so a loose pattern stayed
    // green with the messages delete removed. Mutation testing caught that.
    expect(body).toMatch(/db\.messages\.where\([^)]*\)[^;]*\.delete\(\)/);
    expect(body).toMatch(/db\.conversations\.where\([^)]*\)[^;]*\.delete\(\)/);
  });

  it('refuses to run against the anonymous owner', () => {
    // Anonymous history has its own lifecycle (purgeStaleAnonConversations);
    // letting this function take ANON_OWNER would delete chats belonging to
    // whoever is still using the browser.
    const body = fnBody(DB, 'purgeOwnerConversations');
    expect(body).toMatch(/owner === ANON_OWNER[\s\S]{0,40}return 0/);
  });

  it('is actually called when an identity is left behind', () => {
    // Reading the owner AFTER setLocalChatOwner would purge the identity being
    // signed IN to, so the order matters as much as the call.
    const readBefore = TERMINAL.indexOf('const leavingOwner = getLocalChatOwner()');
    const switched = TERMINAL.indexOf('setLocalChatOwner(nextOwner)');
    expect(readBefore).toBeGreaterThan(-1);
    expect(switched).toBeGreaterThan(-1);
    expect(readBefore).toBeLessThan(switched);

    expect(TERMINAL).toMatch(/purgeOwnerConversations\(leavingOwner\)/);
    // Guarded so that signing in from anonymous, or re-applying the same
    // identity, does not delete anything.
    expect(TERMINAL).toMatch(/leavingOwner !== ANON_OWNER[\s\S]{0,60}leavingOwner !== nextOwner/);
  });

  it('flushes the open conversation to the server before deleting it', () => {
    // The server copy is what makes the delete safe; losing an unsynced chat is
    // the one real cost, so the open one is pushed first.
    const idx = TERMINAL.indexOf('purgeOwnerConversations(leavingOwner)');
    const before = TERMINAL.slice(Math.max(0, idx - 700), idx);
    expect(before).toMatch(/beaconSave\(conv, msgs\)/);
  });
});
