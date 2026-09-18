<script lang="ts">
  /**
   * SynapseSidebar.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Left-side conversation history panel for SynapseTerminal.
   * Mimics ChatGPT sidebar UX with teal neural-terminal aesthetics.
   *
   * Props
   * ─────
   *  • open            — boolean: whether the sidebar is visible
   *  • conversations   — sorted list of Conversation records
   *  • currentId       — id of the active conversation
   *  • onSelect(id)    — switch to a conversation
   *  • onNew()         — create a new conversation
   *  • onRename(id, t) — rename a conversation
   *  • onDelete(id)    — delete a conversation
   *  • onClose()       — close the sidebar panel
   *
   * Svelte 5 runes: $props(), $state(), $effect()
   * GSAP: slide-in from x:-260 on open, slide-out on close
   */

  import { gsap } from 'gsap';
  import type { Conversation } from '@/lib/synapse-db';
  import { t, type Lang } from '@/i18n/utils';
  import SynapseAccount from '@/components/ui/SynapseAccount.svelte';

  // ─── Props ────────────────────────────────────────────────────────────────────

  interface Props {
    open: boolean;
    conversations: Conversation[];
    currentId: string;
    uiLang: Lang;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
  }

  const {
    open,
    conversations,
    currentId,
    uiLang,
    onSelect,
    onNew,
    onRename,
    onDelete,
    onClose,
  }: Props = $props();

  // ─── DOM refs ─────────────────────────────────────────────────────────────────

  let panelEl: HTMLElement | undefined = $state();
  let backdropEl: HTMLElement | undefined = $state();

  // ─── Local state ──────────────────────────────────────────────────────────────

  /** Id of conversation currently being renamed */
  let renamingId = $state('');
  /** Draft title value during rename */
  let renameValue = $state('');
  /** Id of conversation pending delete confirmation */
  let confirmDeleteId = $state('');
  /** The delete-trigger button that opened the confirm dialog — focus returns
      here on cancel/Escape (it survives), or falls back to New Chat on delete. */
  let deleteTriggerEl: HTMLElement | undefined = $state();
  /** The rename-trigger button — focus returns here when the inline rename ends. */
  let renameTriggerEl: HTMLElement | undefined = $state();
  /** Ref to the New Chat button — the safe focus target after a row is deleted. */
  let newChatBtnEl: HTMLElement | undefined = $state();

  // ─── GSAP animation ───────────────────────────────────────────────────────────

  let tl: gsap.core.Timeline | null = null;

  $effect(() => {
    if (!panelEl || !backdropEl) return;

    tl?.kill();

    // House motion rule: reduced motion keeps the state change (the panel
    // must still open and close) and drops the slide — end values are set
    // directly. Checked per toggle, so an OS-setting flip takes effect on
    // the next open without a listener (swarm audit 2026-09-06).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.set(panelEl, { x: open ? 0 : -280, autoAlpha: open ? 1 : 0 });
      gsap.set(backdropEl, { autoAlpha: open ? 1 : 0 });
      return;
    }

    if (open) {
      // Slide panel in from left
      gsap.set(panelEl, { x: -280, autoAlpha: 0 });
      gsap.set(backdropEl, { autoAlpha: 0 });

      tl = gsap
        .timeline({ defaults: { ease: 'power3.out' } })
        .to(backdropEl, { autoAlpha: 1, duration: 0.25 })
        .to(panelEl, { x: 0, autoAlpha: 1, duration: 0.35 }, '-=0.15');
    } else {
      // Slide out
      tl = gsap
        .timeline({ defaults: { ease: 'power2.in' } })
        .to(panelEl, { x: -280, autoAlpha: 0, duration: 0.25 })
        .to(backdropEl, { autoAlpha: 0, duration: 0.2 }, '-=0.1');
    }
  });

  // ─── Rename helpers ───────────────────────────────────────────────────────────

  function startRename(conv: Conversation, trigger?: HTMLElement): void {
    renameTriggerEl = trigger;
    renamingId = conv.id;
    renameValue = conv.title;
  }

  /** Return focus to the rename button (it survives) so a keyboard user isn't
      dropped to <body> when the inline input unmounts; New Chat as a fallback. */
  function restoreRenameFocus(): void {
    const trigger = renameTriggerEl;
    requestAnimationFrame(() => {
      if (trigger && document.contains(trigger)) trigger.focus();
      else newChatBtnEl?.focus();
    });
  }

  function commitRename(id: string): void {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conversations.find((c) => c.id === id)?.title) {
      onRename(id, trimmed);
    }
    renamingId = '';
    restoreRenameFocus();
  }

  function handleRenameKeydown(e: KeyboardEvent, id: string): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(id);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Cancel means DISCARD. The input unmounts when renamingId clears and fires a
      // native blur → commitRename; reset the draft to the stored title first so
      // that commit sees no change and skips onRename. Without this, Escape SAVED.
      renameValue = conversations.find((c) => c.id === id)?.title ?? renameValue;
      renamingId = '';
      restoreRenameFocus();
    }
  }

  // ─── Delete helpers ───────────────────────────────────────────────────────────

  function requestDelete(id: string, e: MouseEvent): void {
    e.stopPropagation();
    // Remember the trigger so focus can return to it when the dialog closes.
    deleteTriggerEl = e.currentTarget as HTMLElement;
    confirmDeleteId = id;
  }

  /**
   * Closes the confirm dialog and restores focus so a keyboard user isn't
   * dumped back to <body>. On cancel/Escape the trigger button still exists →
   * return there; after an actual delete its row is gone → fall back to New Chat.
   */
  function closeDeleteDialog(): void {
    const trigger = deleteTriggerEl;
    confirmDeleteId = '';
    requestAnimationFrame(() => {
      if (trigger && document.contains(trigger)) trigger.focus();
      else newChatBtnEl?.focus();
    });
  }

  function confirmDelete(): void {
    onDelete(confirmDeleteId);
    closeDeleteDialog();
  }

  /**
   * Modal a11y for the delete confirmation: move focus onto the Cancel button
   * when the dialog opens (Svelte action runs on mount of the `{#if}` block).
   */
  function focusOnMount(node: HTMLElement): void {
    node.querySelector<HTMLElement>('.confirm-btn--cancel')?.focus();
  }

  /**
   * Keeps keyboard focus inside the open delete dialog (it claims
   * `aria-modal="true"`, so it must actually trap) and lets Escape cancel.
   */
  function handleDialogKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      closeDeleteDialog();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = e.currentTarget as HTMLElement;
    const focusables = dialog.querySelectorAll<HTMLElement>('button');
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ─── Date formatting ──────────────────────────────────────────────────────────

  function formatDate(ts: number): string {
    const now = Date.now();
    const diff = now - ts;
    const day = 86_400_000;
    if (diff < day) return t(uiLang, 'synapse.sidebar.today');
    if (diff < 2 * day) return t(uiLang, 'synapse.sidebar.yesterday');
    if (diff < 7 * day)
      return t(uiLang, 'synapse.sidebar.daysAgo').replace('{n}', String(Math.floor(diff / day)));
    const locale = uiLang === 'ru' ? 'ru-RU' : 'en-US';
    return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
</script>

<!-- ── Backdrop ─────────────────────────────────────────────────────────────── -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={backdropEl}
  class="sidebar-backdrop"
  style="opacity: 0; visibility: hidden;"
  onclick={onClose}
  aria-hidden="true"
></div>

<!-- ── Panel ───────────────────────────────────────────────────────────────── -->
<aside
  bind:this={panelEl}
  class="sidebar-panel"
  style="transform: translateX(-280px); opacity: 0; visibility: hidden;"
  aria-label={t(uiLang, 'synapse.sidebar.history')}
  role="navigation"
>
  <!-- Header -->
  <div class="sidebar-header">
    <div class="sidebar-logo">
      <span class="sidebar-logo__dot"></span>
      <span class="sidebar-logo__text">SYNAPSE</span>
    </div>
    <!-- Close sidebar button -->
    <button
      class="sidebar-close-btn"
      onclick={onClose}
      aria-label={t(uiLang, 'synapse.sidebar.close')}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M15 5L5 15M5 5l10 10"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>

  <!-- New Chat button -->
  <button
    class="new-chat-btn"
    bind:this={newChatBtnEl}
    onclick={onNew}
    aria-label={t(uiLang, 'synapse.sidebar.newChat')}
  >
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    <span>{t(uiLang, 'synapse.sidebar.newChat')}</span>
  </button>

  <!-- Divider -->
  <div class="sidebar-divider" aria-hidden="true"></div>

  <!-- Conversation list -->
  <div
    class="sidebar-list"
    role="list"
    aria-label={t(uiLang, 'synapse.sidebar.conversationsListLabel')}
  >
    {#if conversations.length === 0}
      <p class="sidebar-empty">{t(uiLang, 'synapse.sidebar.empty')}</p>
    {:else}
      {#each conversations as conv (conv.id)}
        <div
          class="conv-item"
          class:conv-item--active={conv.id === currentId}
          role="listitem"
          title={conv.title}
        >
          {#if renamingId === conv.id}
            <!-- Rename mode: icon + inline input. The input can't live inside a
                 <button>, so this branch keeps them as direct row children. -->
            <svg
              class="conv-icon"
              width="12"
              height="12"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 4h16v10a2 2 0 01-2 2H4a2 2 0 01-2-2V4z"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <path
                d="M6 8h8M6 11h5"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
            <div class="conv-body">
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="conv-rename-input"
                type="text"
                bind:value={renameValue}
                autofocus
                onblur={() => commitRename(conv.id)}
                onkeydown={(e) => handleRenameKeydown(e, conv.id)}
                aria-label={t(uiLang, 'synapse.sidebar.rename')}
              />
            </div>
          {:else}
            <!-- Primary "select conversation" action is a real <button>: natively
                 focusable and Enter/Space-activatable for keyboard/screen-reader
                 users. Kept as a sibling of the rename/delete buttons so no
                 interactive element is nested inside another. -->
            <button
              class="conv-select"
              type="button"
              onclick={() => onSelect(conv.id)}
              aria-label={conv.title}
              aria-current={conv.id === currentId ? 'true' : undefined}
            >
              <svg
                class="conv-icon"
                width="12"
                height="12"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M2 4h16v10a2 2 0 01-2 2H4a2 2 0 01-2-2V4z"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M6 8h8M6 11h5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
              <span class="conv-body">
                <span class="conv-title">{conv.title}</span>
                <span class="conv-date">{formatDate(conv.updatedAt)}</span>
              </span>
            </button>

            <!-- Action buttons (rename + delete) — visible on hover/focus -->
            <div class="conv-actions">
              <button
                class="conv-action-btn conv-rename-btn"
                onclick={(e) => {
                  e.stopPropagation();
                  startRename(conv, e.currentTarget as HTMLElement);
                }}
                aria-label={t(uiLang, 'synapse.sidebar.rename')}
                title={t(uiLang, 'synapse.sidebar.rename')}
              >
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="conv-action-btn conv-delete-btn"
                onclick={(e) => requestDelete(conv.id, e)}
                aria-label={t(uiLang, 'synapse.sidebar.delete')}
                title={t(uiLang, 'synapse.sidebar.delete')}
              >
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M3 6h14M8 6V4h4v2M6 6l1 11h6l1-11"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <!-- ── Account (Google sign-in ⇄ profile) — self-hides when unconfigured ──── -->
  <!-- active={open}: defer loading Google Identity Services until the sidebar is
       actually opened, so landing visitors who never open Synapse pay nothing. -->
  <SynapseAccount {uiLang} active={open} />

  <!-- ── Delete confirmation modal ──────────────────────────────────────────── -->
  {#if confirmDeleteId}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="confirm-overlay" onclick={closeDeleteDialog} aria-hidden="true"></div>
    <div
      class="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={t(uiLang, 'synapse.sidebar.deleteConfirm')}
      use:focusOnMount
      onkeydown={handleDialogKeydown}
    >
      <p class="confirm-text">{t(uiLang, 'synapse.sidebar.deleteConfirm')}</p>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-btn--cancel" onclick={closeDeleteDialog}
          >{t(uiLang, 'synapse.sidebar.cancel')}</button
        >
        <button class="confirm-btn confirm-btn--delete" onclick={confirmDelete}
          >{t(uiLang, 'synapse.sidebar.delete')}</button
        >
      </div>
    </div>
  {/if}
</aside>

<style>
  /* ── Backdrop ──────────────────────────────────────────────────────────────── */
  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: hsla(220, 30%, 4%, 0.55);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    cursor: pointer;
  }

  /* ── Panel ─────────────────────────────────────────────────────────────────── */
  .sidebar-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 10001;
    width: 260px;
    background: #0a0f14;
    border-right: 1px solid hsla(175, 80%, 50%, 0.1);
    display: flex;
    flex-direction: column;
    font-family: 'JetBrains Mono', monospace;
    overflow: hidden;

    box-shadow:
      4px 0 24px hsla(220, 30%, 4%, 0.6),
      0 0 0 1px hsla(175, 80%, 50%, 0.06);
  }

  /* ── Header ────────────────────────────────────────────────────────────────── */
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 16px 14px;
    border-bottom: 1px solid hsla(175, 80%, 50%, 0.07);
    flex-shrink: 0;
  }

  .sidebar-logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sidebar-logo__dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #00ffd5;
    box-shadow: 0 0 8px hsla(175, 100%, 50%, 0.6);
    animation: logo-pulse 2.4s ease-in-out infinite;
  }

  @keyframes logo-pulse {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.3);
      box-shadow: 0 0 14px hsla(175, 100%, 50%, 0.9);
    }
  }

  .sidebar-logo__text {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.22em;
    color: hsla(175, 80%, 60%, 0.5);
    text-transform: uppercase;
    user-select: none;
  }

  .sidebar-close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid hsla(175, 80%, 50%, 0.1);
    border-radius: 6px;
    color: hsla(175, 20%, 55%, 0.5);
    cursor: pointer;
    transition:
      color 180ms ease,
      border-color 180ms ease,
      background 180ms ease;
  }

  .sidebar-close-btn:hover {
    color: #00ffd5;
    border-color: hsla(175, 80%, 50%, 0.35);
    background: hsla(175, 40%, 10%, 0.4);
  }

  /* ── New Chat button ───────────────────────────────────────────────────────── */
  .new-chat-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 12px 12px 8px;
    padding: 10px 14px;
    background: hsla(175, 40%, 10%, 0.4);
    border: 1px solid hsla(175, 80%, 50%, 0.2);
    border-radius: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.76rem;
    font-weight: 500;
    color: #00ffd5;
    cursor: pointer;
    transition:
      background 200ms ease,
      border-color 200ms ease,
      box-shadow 200ms ease,
      transform 150ms ease;
    letter-spacing: 0.04em;
  }

  .new-chat-btn:hover {
    background: hsla(175, 40%, 14%, 0.6);
    border-color: hsla(175, 80%, 50%, 0.45);
    box-shadow: 0 0 16px hsla(175, 80%, 50%, 0.12);
  }

  .new-chat-btn:active {
    transform: scale(0.97);
  }

  /* ── Divider ───────────────────────────────────────────────────────────────── */
  .sidebar-divider {
    height: 1px;
    background: hsla(175, 80%, 50%, 0.07);
    margin: 0 12px 8px;
    flex-shrink: 0;
  }

  /* ── Conversation list ─────────────────────────────────────────────────────── */
  .sidebar-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 8px 12px;
    scrollbar-width: thin;
    scrollbar-color: hsla(175, 80%, 50%, 0.2) transparent;
  }

  .sidebar-list::-webkit-scrollbar {
    width: 3px;
  }
  .sidebar-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .sidebar-list::-webkit-scrollbar-thumb {
    background: hsla(175, 80%, 50%, 0.2);
    border-radius: 999px;
  }

  .sidebar-empty {
    font-size: 0.7rem;
    color: hsla(175, 15%, 50%, 0.4);
    text-align: center;
    padding: 24px 16px;
    letter-spacing: 0.04em;
  }

  /* ── Conversation item ─────────────────────────────────────────────────────── */
  .conv-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition:
      background 180ms ease,
      border-color 180ms ease;
    border: 1px solid transparent;
    margin-bottom: 2px;
    min-height: 48px;
  }

  .conv-item:hover {
    background: hsla(175, 30%, 8%, 0.6);
    border-color: hsla(175, 80%, 50%, 0.08);
  }

  .conv-item--active {
    background: hsla(175, 40%, 8%, 0.7);
    border-color: hsla(175, 80%, 50%, 0.18);
    border-left: 2px solid #00ffd5;
  }

  .conv-item--active .conv-title {
    color: hsla(175, 80%, 70%, 0.95);
  }

  /* The primary select target is a real <button>; strip its native chrome so
     it lays out exactly like the old row content (icon + body, flex:1). */
  .conv-select {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }

  .conv-icon {
    flex-shrink: 0;
    color: hsla(175, 40%, 50%, 0.4);
    margin-top: 1px;
  }

  .conv-item--active .conv-icon {
    color: hsla(175, 80%, 60%, 0.7);
  }

  .conv-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .conv-title {
    font-size: 0.72rem;
    color: hsla(175, 10%, 65%, 0.7);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.01em;
    line-height: 1.4;
    transition: color 180ms ease;
  }

  .conv-date {
    font-size: 0.59rem;
    color: hsla(175, 10%, 45%, 0.45);
    letter-spacing: 0.04em;
  }

  /* Inline rename input */
  .conv-rename-input {
    width: 100%;
    background: hsla(175, 20%, 10%, 0.8);
    border: 1px solid hsla(175, 80%, 50%, 0.35);
    border-radius: 4px;
    padding: 3px 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: #00ffd5;
    outline: none;
    caret-color: #00ffd5;
  }

  /* This input is autofocused on open with outline:none and no :focus rule, so it
     had zero visible focus indicator. Give keyboard/AT users a ring in the
     sidebar's own teal. */
  .conv-rename-input:focus-visible {
    outline: 2px solid hsl(175, 80%, 50%);
    outline-offset: 1px;
    border-color: hsl(175, 80%, 50%);
  }

  /* Action buttons container — appears on hover */
  .conv-actions {
    flex-shrink: 0;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 180ms ease;
  }

  .conv-item:hover .conv-actions,
  .conv-item--active .conv-actions,
  .conv-item:focus-within .conv-actions {
    opacity: 1;
  }

  /* Touch devices have no hover — keep actions discoverable */
  @media (hover: none) {
    .conv-actions {
      opacity: 1;
    }
  }

  .conv-action-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
    transition:
      color 180ms ease,
      background 180ms ease,
      border-color 180ms ease;
  }

  .conv-rename-btn {
    color: hsla(175, 40%, 50%, 0.35);
  }

  .conv-rename-btn:hover {
    color: #00ffd5;
    background: hsla(175, 40%, 12%, 0.5);
    border-color: hsla(175, 80%, 50%, 0.25);
  }

  .conv-delete-btn {
    color: hsla(0, 60%, 55%, 0.35);
  }

  .conv-delete-btn:hover {
    color: hsl(0, 70%, 62%) !important;
    background: hsla(0, 60%, 20%, 0.4);
    border-color: hsla(0, 60%, 40%, 0.3);
  }

  /* ── Delete confirm modal ──────────────────────────────────────────────────── */
  .confirm-overlay {
    position: absolute;
    inset: 0;
    background: hsla(220, 30%, 4%, 0.5);
    z-index: 10;
    cursor: pointer;
  }

  .confirm-dialog {
    position: absolute;
    bottom: 80px;
    left: 16px;
    right: 16px;
    z-index: 11;
    background: #0d1520;
    border: 1px solid hsla(175, 80%, 50%, 0.2);
    border-radius: 12px;
    padding: 18px 16px 14px;
    box-shadow:
      0 8px 32px hsla(220, 30%, 4%, 0.7),
      0 0 0 1px hsla(175, 80%, 50%, 0.06);
  }

  .confirm-text {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: hsla(175, 15%, 70%, 0.8);
    margin: 0 0 14px;
    letter-spacing: 0.03em;
    text-align: center;
  }

  .confirm-actions {
    display: flex;
    gap: 8px;
  }

  .confirm-btn {
    flex: 1;
    padding: 8px 12px;
    border-radius: 7px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: all 180ms ease;
  }

  .confirm-btn--cancel {
    background: transparent;
    border: 1px solid hsla(175, 80%, 50%, 0.15);
    color: hsla(175, 20%, 60%, 0.6);
  }

  .confirm-btn--cancel:hover {
    border-color: hsla(175, 80%, 50%, 0.3);
    color: hsla(175, 20%, 70%, 0.8);
    background: hsla(175, 20%, 10%, 0.3);
  }

  .confirm-btn--delete {
    background: hsla(0, 60%, 20%, 0.5);
    border: 1px solid hsla(0, 60%, 40%, 0.3);
    color: hsl(0, 70%, 62%);
  }

  .confirm-btn--delete:hover {
    background: hsla(0, 60%, 25%, 0.7);
    border-color: hsla(0, 60%, 45%, 0.55);
    box-shadow: 0 0 12px hsla(0, 60%, 40%, 0.2);
  }

  /* ── Mobile: full-width overlay ────────────────────────────────────────────── */
  @media (max-width: 640px) {
    .sidebar-panel {
      width: 100%;
      max-width: 100%;
    }
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it away.
     Measured in dist: the minifier collapses `backdrop-filter` into its -webkit-
     alias and drops the standard declaration, so Firefox renders this backdrop as
     a flat fill. It does not collapse across an @supports boundary. Must stay
     AFTER the base rule — equal specificity, last one wins. */
  @supports (backdrop-filter: blur(1px)) {
    .sidebar-backdrop {
      backdrop-filter: blur(2px);
    }
  }
</style>
