/**
 * lab-copilot-bus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A tiny window-CustomEvent bus so a Lab tool island can publish a short,
 * human-readable "what's on screen now" summary that the LabCopilot panel (a
 * SEPARATE Astro island — they don't share a component tree) can subscribe to.
 *
 * Tools push a plain string summary (e.g. "GPT-4o · 128 tokens") for the
 * "on screen now" line, plus an OPTIONAL structured `detail` record of honest,
 * already-on-screen facts (e.g. { model, totalTokens, backend }). LabCopilot
 * turns `detail` into a compact "Live state: k=v, …" line in the model's
 * context turn — never anything the tool didn't actually compute/display.
 * `summary` stays the single source of truth for the visible "Currently" line
 * (backward compatible with callers that only pass a summary).
 */
import type { LabTool } from '@/lib/lab-copilot-content';

/** A structured "what's actually on screen" fact record — primitives only, so it can't accidentally carry a live object reference into a CustomEvent detail. */
export type LabStateFacts = Record<string, string | number | boolean>;

export interface LabStateDetail {
  tool: LabTool;
  /** Short, display-ready summary of the tool's salient current state. */
  summary: string;
  /** Optional structured facts backing `summary` — see file header. */
  detail?: LabStateFacts;
}

const EVENT = 'lab:copilot-state';

/** Called by a tool island whenever its salient state changes. No-op during SSR. */
export function publishLabState(tool: LabTool, summary: string, detail?: LabStateFacts): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<LabStateDetail>(EVENT, { detail: { tool, summary, detail } })
  );
}

/** Subscribe to state for one tool. Returns an unsubscribe fn. No-op during SSR. */
export function onLabState(tool: LabTool, cb: (detail: LabStateDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<LabStateDetail>).detail;
    if (detail && detail.tool === tool) cb(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
