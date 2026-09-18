/**
 * embeddingTabs.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Embedding Explorer's mode-tab ids, shared between EmbeddingTabs.svelte
 * (the tab bar) and EmbeddingApp.svelte (which owns `activeTab` and decides
 * which panel renders). Kept as a plain module — not exported from a .svelte
 * file's instance script — so both sides get a real, staticly-typed ES import
 * instead of relying on Svelte's component-export semantics.
 */

/** Ordered tab ids — order also drives EmbeddingTabs.svelte's ArrowLeft/ArrowRight roving focus. */
export const TAB_IDS = ['explore', 'languages', 'analogies', 'chunking', 'retrieval'] as const;
export type TabId = (typeof TAB_IDS)[number];
