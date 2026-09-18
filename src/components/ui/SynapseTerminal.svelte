<script lang="ts">
  /**
   * SynapseTerminal.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Fullscreen neural terminal — immersive conversation panel with Synapse AI.
   *
   * Usage:
   *   <SynapseTerminal open={false} onClose={() => {}} />
   *
   * Props
   * ─────
   *  • open    — boolean: show/hide the panel
   *  • onClose — callback fired after the exit animation completes
   *
   * Architecture
   * ────────────
   *  • GSAP timeline handles entry/exit (overlay → orb → input bar → close btn)
   *  • SynapseOrb state is driven by chat state machine
   *  • Typewriter effect uses recursive setTimeout (char-by-char, 30-50ms/char)
   *  • Mock responses from synapse-mock.ts; real backend in Phase 3.4.5
   *  • prefers-reduced-motion: typewriter disabled, text appears instantly
   *  • Escape key closes panel
   *  • Body scroll lock on open
   *
   * Svelte 5 runes used
   * ───────────────────
   *  • $props()  — typed component props
   *  • $state()  — reactive DOM refs and chat state
   *  • $effect() — open/close watcher, auto-scroll, body lock
   */

  import { gsap } from 'gsap';
  import { onMount, onDestroy } from 'svelte';
  import SynapseOrb from '@/components/ui/SynapseOrb.svelte';
  import SynapseSidebar from '@/components/ui/SynapseSidebar.svelte';
  import { generateMessageId, type ChatMessage } from '@/lib/synapse-mock';
  import { createSynapseClient, type FallbackInfo } from '@/lib/synapse-client';
  import { renderInline } from '@/lib/synapse-render';
  import { SYNAPSE_API_BASE } from '@/lib/api-config';
  import { t, getLangFromPath, type Lang } from '@/i18n/utils';
  import type { OrbState } from '@/lib/synapse-orb-renderer';
  import { createAudioEngine, type AudioEngine, type AudioMicError } from '@/lib/synapse-audio';
  import {
    db,
    createConversation,
    addMessage,
    updateMessageContent,
    getMessages as dbGetMessages,
    listConversations as dbListConversations,
    deleteConversation as dbDeleteConversation,
    renameConversation as dbRenameConversation,
    autoTitle,
    migrateOldData,
    setLocalChatOwner,
    getLocalChatOwner,
    ANON_OWNER,
    adoptAnonConversations,
    purgeStaleAnonConversations,
    purgeOwnerConversations,
    touchBrowserSession,
    type Conversation,
    type StoredMessage,
  } from '@/lib/synapse-db';
  import {
    pushToServer,
    beaconSave,
    serverRename,
    serverDelete,
    setupVisibilitySync,
    pullFromServer,
  } from '@/lib/synapse-db-server';
  import { onAuthChange, isSignedIn, getProfile } from '@/lib/auth';

  // ─── Synapse client instance ──────────────────────────────────────────────
  const synapseClient = createSynapseClient({ baseUrl: SYNAPSE_API_BASE });

  /**
   * Speech-to-text works again, so the microphone is back.
   *
   * It was hidden on 15 August because the live /api/voice returned HTTP 500 in
   * 0.1 s: the configured path ran through the multimodal E4B, which is not the
   * model being served, so the button asked for the microphone and handed the
   * visitor a server error. Hidden rather than deleted — everything behind it
   * stayed intact, and this constant is the whole switch.
   *
   * Turned back on the same evening, once the Google Cloud Speech-to-Text
   * backend was made to work and VERIFIED end to end against the live endpoint,
   * not merely deployed: a real Chirp-synthesised clip POSTed to
   * https://api.vkvstudio.com/api/voice came back HTTP 200 with
   * `x-synapse-transcript` reading back the exact sentence and 66 KB of spoken
   * reply. Speech in, Gemma, speech out.
   *
   * If voice input ever breaks again, set this to false and say so on the
   * privacy page in the same commit — a control that fails is worse than a
   * control that is absent, which is the whole reason it was ever hidden.
   */
  const STT_AVAILABLE = true;

  /**
   * Write a message to IndexedDB without letting a failed write break the send.
   *
   * `await addMessage(...)` sat bare in the middle of sendMessage, so a rejected
   * write — private browsing, a quota refusal, an evicted or corrupted store —
   * threw straight out of the function. `isThinking` had already been set to
   * true and nothing downstream ran to put it back, so the terminal sat on
   * PROCESSING for the rest of the session with the send button and the mic
   * disabled, and no error anywhere. A browser that will not store history is a
   * reason to lose history, not a reason to stop being able to talk.
   */
  async function persistMessage(
    convId: string,
    msg: { msgId: string; role: 'user' | 'assistant'; content: string; timestamp: number }
  ): Promise<void> {
    try {
      await addMessage(convId, msg);
    } catch (err) {
      console.warn('[SynapseTerminal] Could not save a message locally:', err);
    }
  }

  // ─── Connection source indicator ─────────────────────────────────────────
  let connectionSource = $state<'live' | 'mock' | 'unknown'>('unknown');
  /**
   * Why the mock is answering. The badge itself stays honest either way — the
   * mock really is what replied — but its tooltip used to assert "backend
   * unavailable" for every failure, including the two cases where the server
   * answered perfectly well and said it was busy (429, and the 503 +
   * Retry-After that main.py sheds load with). `null` means we have no reason
   * to report, which is the state before anything has failed.
   */
  let fallbackInfo = $state<FallbackInfo | null>(null);

  let mockBadgeTitle = $derived.by(() => {
    const info = fallbackInfo;
    if (info?.kind === 'auth') {
      return t(uiLang, 'synapse.terminal.badgeMockTitleAuth');
    }
    if (info?.kind === 'quota') {
      const base = t(uiLang, 'synapse.terminal.badgeMockTitleQuota');
      if (!info.retryAfter) return base;
      const mins = Math.round(info.retryAfter / 60);
      return mins >= 60 ? `${base} (~${Math.round(mins / 60)}h)` : `${base} (~${mins}m)`;
    }
    if (info?.kind === 'busy') {
      const base = t(uiLang, 'synapse.terminal.badgeMockTitleBusy');
      return info.retryAfter ? `${base} (${info.retryAfter}s)` : base;
    }
    if (info?.kind === 'error') {
      const base = t(uiLang, 'synapse.terminal.badgeMockTitleError');
      return info.status ? `${base} (HTTP ${info.status})` : base;
    }
    return t(uiLang, 'synapse.terminal.badgeMockTitle');
  });

  // ─── UI language (for the per-message model badge) ───────────────────────
  // Detected once at mount from the URL locale (/en/… | /ru/…). This island is
  // otherwise English-only, but the model badge is user-facing copy → localized.
  let uiLang = $state<Lang>('en');

  /** Localized label + tooltip for a message's model badge, or null to hide it. */
  function modelBadge(
    model: string | undefined
  ): { label: string; title: string; cls: string } | null {
    if (model === 'e2b' || model === 'e4b') {
      return {
        label: t(uiLang, `synapse.model.${model}`),
        title: t(uiLang, `synapse.model.${model}Title`),
        cls: `model-badge--${model}`,
      };
    }
    if (model === 'mock') {
      return {
        label: t(uiLang, 'synapse.model.mock'),
        title: t(uiLang, 'synapse.model.mockTitle'),
        cls: 'model-badge--mock',
      };
    }
    return null;
  }

  // ─── Audio Engine (voice UI) ──────────────────────────────────────────────
  let audioEngine: AudioEngine | null = null;
  let isVoiceRecording = $state(false);
  let audioAmplitude = $state(0);
  let voiceRafId = 0;

  // ─── Props ───────────────────────────────────────────────────────────────────

  interface Props {
    /** Show / hide the terminal panel */
    open?: boolean;
    /** Called after the exit animation completes */
    onClose?: () => void;
  }

  const { open = false, onClose = () => {} }: Props = $props();

  // ─── DOM refs ────────────────────────────────────────────────────────────────

  let overlayEl: HTMLElement | undefined = $state();
  let orbWrapEl: HTMLElement | undefined = $state();
  let conversationEl: HTMLElement | undefined = $state();
  let inputBarEl: HTMLElement | undefined = $state();
  let closeBtnEl: HTMLButtonElement | undefined = $state();
  let hamburgerBtnEl: HTMLButtonElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  // ── Data-processing consent ─────────────────────────────────────────────────
  // HO-49-N (ст. 9 ч. 7): consent has to be an explicit act, not the mere fact
  // of using the site. Until the button below is pressed once per browser, the
  // composer is disabled and both send paths refuse to fire. The flag lives in
  // localStorage — private windows simply ask again, which is the right
  // failure direction for a shared machine.
  const DATA_CONSENT_KEY = 'synapse-data-consent';
  function readDataConsent(): boolean {
    try {
      return localStorage.getItem(DATA_CONSENT_KEY) === '1';
    } catch {
      return false;
    }
  }
  let dataConsented = $state(readDataConsent());
  function grantDataConsent(): void {
    try {
      localStorage.setItem(DATA_CONSENT_KEY, '1');
    } catch {
      /* storage unavailable (private mode) — consent holds for this session */
    }
    dataConsented = true;
    textareaEl?.focus();
  }

  // ─── Chat state ──────────────────────────────────────────────────────────────

  let messages = $state<ChatMessage[]>([]);
  let inputValue = $state('');
  let orbState = $state<OrbState>('idle');
  let isTyping = $state(false); // user is typing
  let isThinking = $state(false); // waiting for response
  let isSpeaking = $state(false); // typewriter in progress
  let typewriterText = $state(''); // currently rendered typewriter string
  let typewriterMsgId = $state(''); // which message is being typed
  let hasMessages = $state(false);
  let isVoiceSpeaking = $state(false); // backend audio playback in progress

  // Screen-reader announcement of the COMPLETED assistant reply. The visible
  // conversation is intentionally NOT a live region (token-by-token streaming
  // would spam a screen reader with partial sentences) — instead we announce
  // the finished message once here, politely. See the .visually-hidden node
  // in the template and `plainForSpeech()`.
  let liveAnnouncement = $state('');

  // ─── Stream abort controller ─────────────────────────────────────────────────
  // Allows cancelling in-flight chat/voice streams when switching conversations.
  let _streamAbort: AbortController | null = null;

  // ─── Generation counter (non-reactive) ───────────────────────────────────────
  // Closes the "natural completion" gap that AbortController can't cover: a
  // stream that finishes normally right as the user switches conversations.
  // Plain `let`, NOT `$state` — it must never be read inside an `$effect`.
  let _activeGen = 0;

  // ─── Sidebar / conversation state ────────────────────────────────────────────

  let sidebarOpen = $state(false);
  let currentConversationId = $state('');
  let conversations = $state<Conversation[]>([]);

  // Cleanup function for visibility sync
  let _cleanupVisibility: (() => void) | null = null;
  let _heartbeat: number | null = null;
  // Cleanup function for the auth-change subscription
  let _cleanupAuth: (() => void) | null = null;

  /**
   * On sign-in, adopt THIS device's local chats into the account by pushing each
   * one to the server (best-effort, background). Anonymous chats made before
   * signing in thus become part of the account's server-side history.
   */
  async function backupLocalChatsToAccount(): Promise<void> {
    if (!isSignedIn()) return;
    try {
      // Only the anonymous chats created in THIS page session. It used to push
      // every conversation in the store, which on a shared browser handed a
      // previous visitor's transcripts to whoever signed in next — permanently,
      // since the server adopts any id it has not already seen.
      const adopted = await adoptAnonConversations();
      for (const c of adopted) {
        const msgs = await dbGetMessages(c.id);
        if (msgs.length > 0) pushToServer(c, msgs);
      }
    } catch {
      // best-effort; local IndexedDB remains the source of truth
    }
  }

  /**
   * Full two-way reconcile on sign-in: PULL the account's chats from the server
   * into local Dexie (so another device's history appears here), refresh the UI
   * if anything arrived, then PUSH this device's local-only chats up. Pull runs
   * first so the merge sees the freshest remote state.
   */
  /**
   * Re-point the terminal at the identity that is signed in now.
   *
   * Runs on every auth change, in BOTH directions. Signing out is the half
   * that used to be missing entirely: `signOut()` clears the token and
   * sessionStorage but never touched IndexedDB, so the previous account's
   * conversation list and open transcript simply stayed on screen for whoever
   * sat down next.
   */
  async function applyIdentity(): Promise<void> {
    const nextOwner = getProfile()?.sub ?? null;
    // Read BEFORE the switch: this is the identity whose rows are about to
    // stop being reachable through the UI.
    const leavingOwner = getLocalChatOwner();
    setLocalChatOwner(nextOwner);

    // Leaving an account — flush what is open, then take its transcripts off
    // this disk. Until now they stayed forever: sign-out cleared the token and
    // the screen, and the stale-chat sweep only ever removed anonymous rows, so
    // on a borrowed machine the next person could read every chat straight out
    // of IndexedDB. The server keeps the durable copy and pullFromServer()
    // brings it all back on the next sign-in.
    if (leavingOwner && leavingOwner !== ANON_OWNER && leavingOwner !== nextOwner) {
      try {
        if (currentConversationId) {
          const conv = await db.conversations.get(currentConversationId);
          const msgs = await dbGetMessages(currentConversationId);
          if (conv && msgs.length > 0) beaconSave(conv, msgs);
        }
      } catch {
        // A failed flush must not keep the transcripts on a machine the person
        // is walking away from; the risk it protects against is losing an
        // unsynced chat, and that is the smaller of the two.
      }
      await purgeOwnerConversations(leavingOwner);
    }

    // Everything on screen belongs to the identity we are LEAVING, so it is
    // cleared here for both directions rather than in one branch. Signing in
    // used to return early and delegate the refresh to syncOnSignIn(), which
    // only re-read the list `if (pulled)` — so a fresh account with nothing on
    // the server pulled nothing, refreshed nothing, and kept the previous
    // person's sidebar and open transcript visible until a reload. The owner
    // filter was working the whole time; the view simply never asked it again.
    // That is a worse failure than a wrong query, because it looks exactly like
    // sign-in not separating anything at all.
    messages = [];
    currentConversationId = null;

    // Adoption of this session's anonymous chats happens inside, and has to
    // land before the list below is read or the just-adopted chat is missing
    // from the sidebar it was adopted into.
    if (isSignedIn()) {
      await syncOnSignIn();
    }

    // Scoped to whoever is signed in NOW. Signed out, that is the anonymous
    // owner: the account's chats stay on disk under their `sub` and return on
    // the next sign-in, they are simply not visible to the next person here.
    conversations = await dbListConversations();
    if (conversations.length > 0) {
      await loadConversation(conversations[0].id);
    } else {
      await handleNewChat();
    }
  }

  async function syncOnSignIn(): Promise<void> {
    if (!isSignedIn()) return;
    try {
      await pullFromServer();
    } catch {
      // best-effort; local IndexedDB remains the source of truth
    }
    // Awaited, unlike before: this re-tags this session's anonymous chats to
    // the new owner, and applyIdentity() reads the conversation list straight
    // afterwards. Left un-awaited, that read could race the re-tag and drop the
    // chat the visitor was in the middle of when they signed in.
    await backupLocalChatsToAccount();
  }

  // Detect prefers-reduced-motion once at mount
  let reducedMotion = false;

  // ─── Derived orb state ───────────────────────────────────────────────────────

  $effect(() => {
    if (isVoiceSpeaking) {
      orbState = 'speaking';
    } else if (isSpeaking) {
      orbState = 'speaking';
    } else if (isThinking) {
      orbState = 'thinking';
    } else if (isVoiceRecording) {
      orbState = 'listening';
    } else if (isTyping) {
      orbState = 'listening';
    } else {
      orbState = 'idle';
    }
  });

  // ─── Sync voice audioAmplitude → orb ────────────────────────────────────────
  // The audio engine updates its `amplitude` and `playbackAmplitude` properties
  // each RAF frame. We run our own RAF here so that Svelte's reactivity picks
  // up the value via the $state wrapper (audioAmplitude).

  function startVoiceAmplitudeLoop(): void {
    stopVoiceAmplitudeLoop();
    const tick = () => {
      if (!audioEngine) return;
      if (audioEngine.isRecording) {
        audioAmplitude = audioEngine.amplitude;
        voiceRafId = requestAnimationFrame(tick);
      } else if (audioEngine.isPlaying) {
        audioAmplitude = audioEngine.playbackAmplitude;
        voiceRafId = requestAnimationFrame(tick);
      } else {
        audioAmplitude = 0;
      }
    };
    voiceRafId = requestAnimationFrame(tick);
  }

  function stopVoiceAmplitudeLoop(): void {
    if (voiceRafId) {
      cancelAnimationFrame(voiceRafId);
      voiceRafId = 0;
    }
    audioAmplitude = 0;
  }

  // ─── GSAP timeline refs ──────────────────────────────────────────────────────

  let entryTl: gsap.core.Timeline | null = null;
  let exitTl: gsap.core.Timeline | null = null;

  // ─── Mount: prefers-reduced-motion + audio engine init ──────────────────────

  onMount(async () => {
    reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Locale for the model badge, from the page URL (/en/… | /ru/…).
    if (typeof window !== 'undefined') {
      uiLang = getLangFromPath(window.location.pathname);
    }

    audioEngine = createAudioEngine();

    // Scope local storage to whoever is signed in RIGHT NOW, before anything
    // reads it. Without this the first list on mount returned every
    // conversation in the browser profile — including a previous visitor's —
    // and rendered the newest one on screen with no authentication involved.
    setLocalChatOwner(getProfile()?.sub);

    // Subscribe to sign-in BEFORE the awaits below. GIS `auto_select` can restore a
    // session within a few hundred ms of load — subscribing only after the async
    // storage work would race and miss that silent sign-in. We also run one sync
    // immediately in case auth already resolved before this line executed.
    _cleanupAuth = onAuthChange(() => {
      void applyIdentity();
    });
    if (isSignedIn()) syncOnSignIn();

    // Migrate old storage formats → Dexie (runs once)
    await migrateOldData();

    // Anonymous history lasts exactly as long as the browser stays open. This
    // clears what a PREVIOUS browser session left behind, before the list below
    // reads it — so a chat someone had here yesterday is never rendered to
    // whoever sits down today. Signing in is what makes history durable; that is
    // the whole point of the account, and it should be true rather than merely
    // advertised. Runs once per browser session and only touches anonymous rows.
    await purgeStaleAnonConversations();

    // Load conversations from Dexie (instant, survives Ctrl+R)
    conversations = await dbListConversations();
    if (conversations.length > 0) {
      await loadConversation(conversations[0].id);
    } else {
      await handleNewChat();
    }

    // Setup visibility-change sync (beacon when tab hidden)
    _cleanupVisibility = setupVisibilitySync(() => currentConversationId);

    // Tell other tabs we are alive. purgeStaleAnonConversations() reads this to
    // tell "the browser was closed" apart from "a second tab just opened" — the
    // two looked identical to sessionStorage, and the wrong guess deleted the
    // conversation another tab was still writing into. The interval is well
    // under SESSION_GAP_MS so a tab opened at any moment finds a fresh mark.
    _heartbeat = window.setInterval(touchBrowserSession, 20_000);
  });

  onDestroy(() => {
    stopVoiceAmplitudeLoop();
    audioEngine?.destroy();
    audioEngine = null;
    _cleanupVisibility?.();
    _cleanupAuth?.();
    if (_heartbeat !== null) {
      clearInterval(_heartbeat);
      _heartbeat = null;
    }
  });

  // ─── Open / Close watcher ────────────────────────────────────────────────────

  $effect(() => {
    if (!overlayEl || !orbWrapEl || !inputBarEl || !closeBtnEl) return;

    if (open) {
      playEntry();
    } else {
      // Only play exit if overlay is visible (opacity > 0)
      const currentOpacity = parseFloat(window.getComputedStyle(overlayEl).opacity);
      if (currentOpacity > 0) {
        playExit();
      }
    }
  });

  // ─── Body scroll lock ────────────────────────────────────────────────────────

  $effect(() => {
    if (typeof document === 'undefined') return;
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  });

  // ─── Auto-scroll on new messages ─────────────────────────────────────────────

  $effect(() => {
    // Track messages length AND last message content to trigger scroll during streaming
    const _len = messages.length;
    const _lastContent = _len > 0 ? messages[_len - 1].content : '';
    const _tw = typewriterText;

    if (conversationEl) {
      // Use requestAnimationFrame so DOM has updated
      requestAnimationFrame(() => {
        if (conversationEl) {
          conversationEl.scrollTop = conversationEl.scrollHeight;
        }
      });
    }
  });

  // ─── Streaming content throttle ─────────────────────────────────────────────
  // During streaming, we throttle Dexie writes to avoid flooding IDB.
  let _streamSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let _pendingStreamContent: { convId: string; msgId: string; content: string } | null = null;

  /** Flush any pending stream content to Dexie. */
  async function flushStreamContent(): Promise<void> {
    if (_streamSaveTimer) {
      clearTimeout(_streamSaveTimer);
      _streamSaveTimer = null;
    }
    if (_pendingStreamContent) {
      const { convId, msgId, content } = _pendingStreamContent;
      _pendingStreamContent = null;
      await updateMessageContent(convId, msgId, content);
    }
  }

  /** Schedule a throttled Dexie write for streaming content (every 500ms). */
  function scheduleStreamSave(convId: string, msgId: string, content: string): void {
    _pendingStreamContent = { convId, msgId, content };
    if (!_streamSaveTimer) {
      _streamSaveTimer = setTimeout(() => {
        _streamSaveTimer = null;
        void flushStreamContent();
      }, 500);
    }
  }

  /** Refresh the conversations list from Dexie (for sidebar). */
  async function refreshConversations(): Promise<void> {
    conversations = await dbListConversations();
  }

  // ─── Keyboard: Escape to close + focus trap (aria-modal dialog) ──────────────

  $effect(() => {
    if (!open) return;

    // Remember what opened the terminal so we can restore focus on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => {
      if (!overlayEl) return [];
      return Array.from(
        overlayEl.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
    };

    // Move focus INTO the dialog (the primary input) so keyboard/AT users don't
    // stay on the trigger behind the modal.
    requestAnimationFrame(() => {
      (textareaEl ?? focusables()[0])?.focus();
    });

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key !== 'Tab' || !overlayEl) return;
      // Keep Tab focus inside the modal.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!overlayEl.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      // Restore focus to whatever opened the terminal.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  });

  // ─── GSAP Entry Animation ────────────────────────────────────────────────────

  function playEntry(): void {
    if (!overlayEl || !orbWrapEl || !inputBarEl || !closeBtnEl) return;

    // Kill any running exit
    exitTl?.kill();

    const headerBtns = [closeBtnEl, hamburgerBtnEl].filter(
      (el): el is HTMLButtonElement => el != null
    );

    // Reduced-motion: show instantly
    if (reducedMotion) {
      gsap.set(overlayEl, { autoAlpha: 1 });
      gsap.set(orbWrapEl, { scale: 1, autoAlpha: 1 });
      gsap.set(inputBarEl, { y: 0, autoAlpha: 1 });
      gsap.set(headerBtns, { autoAlpha: 1 });
      return;
    }

    // Initial state: hidden
    gsap.set(overlayEl, { autoAlpha: 0 });
    gsap.set(orbWrapEl, { scale: 0, autoAlpha: 0 });
    gsap.set(inputBarEl, { y: 60, autoAlpha: 0 });
    gsap.set(headerBtns, { autoAlpha: 0 });

    entryTl = gsap
      .timeline({ defaults: { ease: 'power2.out' } })
      // 1. Overlay fade in
      .to(overlayEl, { autoAlpha: 1, duration: 0.3 })
      // 2. Orb scale in with spring overshoot
      .to(orbWrapEl, { scale: 1, autoAlpha: 1, duration: 0.4, ease: 'back.out(1.7)' }, '-=0.1')
      // 3. Input bar slide up
      .to(inputBarEl, { y: 0, autoAlpha: 1, duration: 0.3, ease: 'power3.out' }, '-=0.2')
      // 4. Header buttons fade in
      .to(headerBtns, { autoAlpha: 1, duration: 0.2 }, '-=0.1');
  }

  // ─── GSAP Exit Animation ─────────────────────────────────────────────────────

  function playExit(callback?: () => void): void {
    if (!overlayEl || !orbWrapEl || !inputBarEl || !closeBtnEl) {
      callback?.();
      onClose();
      return;
    }

    // Kill any running entry
    entryTl?.kill();

    const headerBtns = [closeBtnEl, hamburgerBtnEl].filter(
      (el): el is HTMLButtonElement => el != null
    );

    // Reduced-motion: hide instantly
    if (reducedMotion) {
      gsap.set(overlayEl, { autoAlpha: 0 });
      callback?.();
      onClose();
      return;
    }

    exitTl = gsap
      .timeline({
        onComplete: () => {
          callback?.();
          onClose();
        },
      })
      // 1. Input bar slides down
      .to(inputBarEl, { y: 60, autoAlpha: 0, duration: 0.2, ease: 'power2.in' })
      // 2. Orb scales out
      .to(orbWrapEl, { scale: 0, autoAlpha: 0, duration: 0.3, ease: 'power2.in' }, '-=0.05')
      // 3. Header buttons fade out
      .to(headerBtns, { autoAlpha: 0, duration: 0.15 }, '-=0.1')
      // 4. Overlay fades out
      .to(overlayEl, { autoAlpha: 0, duration: 0.25 }, '-=0.05');
  }

  // ─── Full chat state reset ───────────────────────────────────────────────────
  // Centralised cleanup — called on conversation switch, close, and new chat.

  function resetChatState(): void {
    // 1. Abort any active stream (text or voice)
    if (_streamAbort) {
      _streamAbort.abort();
      _streamAbort = null;
    }
    // 1b. Bump the generation counter so any in-flight send's finally-tail
    // housekeeping (which may run after the AbortController stops being useful,
    // e.g. a stream that already completed naturally) recognizes it's stale.
    _activeGen++;
    // 2. Cancel typewriter animation
    cancelTypewriter();
    // 3. Clear throttled stream save timer
    if (_streamSaveTimer) {
      clearTimeout(_streamSaveTimer);
      _streamSaveTimer = null;
    }
    _pendingStreamContent = null;
    // 4. Reset all transient UI states
    isThinking = false;
    isSpeaking = false;
    isVoiceSpeaking = false;
    isTyping = false;
    inputValue = '';
    // 5. Stop voice recording / playback if active
    if (isVoiceRecording && audioEngine) {
      audioEngine.stopRecording().catch(() => {});
      isVoiceRecording = false;
    }
    audioEngine?.stopPlayback();
    stopVoiceAmplitudeLoop();
  }

  // ─── Close handler ───────────────────────────────────────────────────────────

  function handleClose(): void {
    // Flush any pending stream content before closing
    if (!isSpeaking && !isThinking) {
      void flushStreamContent();
    }
    // Tell backend to unload models (fire-and-forget)
    fetch(`${SYNAPSE_API_BASE}/api/session/close`, { method: 'POST' }).catch(() => {});
    // Full state reset (aborts stream, cancels typewriter, clears timers)
    resetChatState();
    sidebarOpen = false;
    playExit();
  }

  // ─── Conversation management ──────────────────────────────────────────────────

  /** Load a conversation's messages and make it current. */
  async function loadConversation(id: string): Promise<void> {
    resetChatState();
    currentConversationId = id;

    // Read messages from Dexie → convert to ChatMessage format
    const stored = await dbGetMessages(id);
    messages = stored.map((m) => ({
      id: m.msgId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));
    hasMessages = messages.length > 0;
  }

  /** Switch to a different conversation from the sidebar. */
  async function handleSelectConversation(id: string): Promise<void> {
    if (id === currentConversationId) {
      sidebarOpen = false;
      return;
    }
    try {
      await flushStreamContent(); // save any pending stream data
      await loadConversation(id);
    } catch (err) {
      console.error('[Synapse] Failed to switch conversation:', err);
    }
    sidebarOpen = false;
  }

  /** Start a new blank chat from the sidebar button. */
  async function handleNewChat(): Promise<void> {
    try {
      await flushStreamContent();
      resetChatState();
      const conv = await createConversation();
      currentConversationId = conv.id;
      conversations = [conv, ...conversations];
      messages = [];
      hasMessages = false;
    } catch (err) {
      console.error('[Synapse] Failed to create new chat:', err);
    }
    sidebarOpen = false;
  }

  /** Rename a conversation (called by sidebar inline rename). */
  async function handleRenameConversation(id: string, title: string): Promise<void> {
    await dbRenameConversation(id, title);
    serverRename(id, title);
    await refreshConversations();
  }

  /** Delete a conversation (called by sidebar delete button). */
  async function handleDeleteConversation(id: string): Promise<void> {
    await dbDeleteConversation(id);
    serverDelete(id);
    conversations = conversations.filter((c) => c.id !== id);
    if (id === currentConversationId) {
      if (conversations.length > 0) {
        await loadConversation(conversations[0].id);
      } else {
        await handleNewChat();
      }
    }
  }

  // ─── Voice mic toggle ─────────────────────────────────────────────────────────

  async function handleMicClick(): Promise<void> {
    if (!audioEngine) return;

    if (isVoiceRecording) {
      // ── Stop recording & send ─────────────────────────────────────────────
      await stopVoiceRecording();
    } else {
      // ── Start recording ───────────────────────────────────────────────────
      if (isThinking || isVoiceSpeaking) return; // busy

      try {
        await audioEngine.startRecording();
        isVoiceRecording = true;
        startVoiceAmplitudeLoop();
      } catch (err) {
        const micErr = err as AudioMicError;
        console.warn('[SynapseTerminal] Mic error:', micErr);
        addSystemMessage(
          micErr.kind === 'not-found'
            ? t(uiLang, 'synapse.terminal.errNoMic')
            : t(uiLang, 'synapse.terminal.errMicUnavailable')
        );
      }
    }
  }

  async function stopVoiceRecording(): Promise<void> {
    if (!audioEngine || !isVoiceRecording) return;

    isVoiceRecording = false;
    const blob = await audioEngine.stopRecording();
    stopVoiceAmplitudeLoop();

    if (!blob) return; // too short or empty — discard silently

    await sendVoiceMessage(blob);
  }

  async function sendVoiceMessage(audioBlob: Blob): Promise<void> {
    if (!audioEngine) return;
    if (!dataConsented) return; // no processing before the explicit consent act

    // Snapshot the target conversation + generation, and stand up the abort
    // controller, all before any `await` — so a mid-send conversation switch
    // (resetChatState → _streamAbort.abort() + _activeGen++) can't make stale
    // tokens/persistence bleed into the newly-opened conversation.
    const convId = currentConversationId;
    // Same reasoning as sendMessage: never orphan a stream that is still open —
    // it shares the UI flags and the persistence path with this one.
    _streamAbort?.abort();
    _streamAbort = new AbortController();
    const streamSignal = _streamAbort.signal;
    const myGen = _activeGen;

    // Add placeholder user message
    const listeningPlaceholder = t(uiLang, 'synapse.terminal.listeningPlaceholder');
    const userMsg: ChatMessage = {
      id: generateMessageId(),
      role: 'user',
      content: listeningPlaceholder,
      timestamp: Date.now(),
    };
    messages = [...messages, userMsg];
    hasMessages = true;
    isThinking = true;

    // ➙ Save user placeholder to Dexie IMMEDIATELY (best-effort — see persistMessage).
    // Same hazard as the text path: this one also sets isThinking first.
    await persistMessage(convId, {
      msgId: userMsg.id,
      role: 'user',
      content: listeningPlaceholder,
      timestamp: userMsg.timestamp,
    });
    if (streamSignal.aborted) return;

    // Pre-create assistant message (empty, will be filled by tokens)
    let assistantMsgId = '';
    let audioToPlay: Blob | null = null;

    try {
      await synapseClient.sendVoiceStream(
        audioBlob,
        {
          onTranscript(data) {
            if (streamSignal.aborted) return;
            // Update user message with actual transcript
            const transcriptText = `🎤 ${data.text}`;
            messages = messages.map((m) =>
              m.id === userMsg.id ? { ...m, content: transcriptText } : m
            );
            // ➙ Update transcript in Dexie
            void updateMessageContent(convId, userMsg.id, transcriptText);
            isThinking = false;

            // Create assistant message shell
            const assistantMsg: ChatMessage = {
              id: generateMessageId(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
            };
            messages = [...messages, assistantMsg];
            assistantMsgId = assistantMsg.id;
            // ➙ Save assistant shell to Dexie
            void addMessage(convId, {
              msgId: assistantMsg.id,
              role: 'assistant',
              content: '',
              timestamp: assistantMsg.timestamp,
            });
            isSpeaking = true;
            connectionSource = 'live';
          },
          onToken(token) {
            if (streamSignal.aborted || !assistantMsgId) return;
            messages = messages.map((m) =>
              m.id === assistantMsgId ? { ...m, content: m.content + token } : m
            );
            // ➙ Throttled save to Dexie
            const updated = messages.find((m) => m.id === assistantMsgId);
            if (updated) {
              scheduleStreamSave(convId, assistantMsgId, updated.content);
            }
          },
          onAudio(blob) {
            if (streamSignal.aborted) return;
            audioToPlay = blob;
          },
          onDone() {
            if (streamSignal.aborted) return;
            isSpeaking = false;
            connectionSource = 'live';
          },
          onError(err) {
            if (streamSignal.aborted) return;
            console.error('[SynapseTerminal] Voice stream error:', err);
            isThinking = false;
            isSpeaking = false;
            // Update user message if still placeholder
            messages = messages.map((m) =>
              m.id === userMsg.id && m.content === listeningPlaceholder
                ? { ...m, content: t(uiLang, 'synapse.terminal.voiceMessagePlaceholder') }
                : m
            );
            addSystemMessage(t(uiLang, 'synapse.terminal.errVoiceProcessingFailed'));
          },
        },
        streamSignal
      );
    } catch (err) {
      if (!streamSignal.aborted) {
        console.warn('[SynapseTerminal] Voice stream failed:', err);
        isThinking = false;
        isSpeaking = false;
        addSystemMessage(t(uiLang, 'synapse.terminal.errVoiceServerOffline'));
      }
      return;
    } finally {
      // Only clean up if this controller is still the active one
      if (_streamAbort?.signal === streamSignal) {
        _streamAbort = null;
      }
    }

    // Play audio after stream completes (only if not aborted)
    if (audioToPlay && !streamSignal.aborted) {
      isVoiceSpeaking = true;
      startVoiceAmplitudeLoop();
      try {
        await audioEngine.playAudio(audioToPlay);
      } catch (err) {
        console.warn('[SynapseTerminal] Playback error:', err);
      } finally {
        isVoiceSpeaking = false;
        stopVoiceAmplitudeLoop();
      }
    }

    // Save complete conversation to Dexie after voice exchange
    if (!streamSignal.aborted) {
      await flushStreamContent();
      if (myGen !== _activeGen) return;
      // Final content save
      if (assistantMsgId) {
        const finalMsg = messages.find((m) => m.id === assistantMsgId);
        if (finalMsg) {
          await updateMessageContent(convId, assistantMsgId, finalMsg.content);
        }
      }
      if (myGen !== _activeGen) return;
      await autoTitle(convId);
      if (myGen !== _activeGen) return;
      await refreshConversations();
      if (myGen !== _activeGen) return;
      // Background server push
      const conv = conversations.find((c) => c.id === convId);
      if (conv) {
        const storedMsgs = await dbGetMessages(convId);
        pushToServer(conv, storedMsgs);
      }
    }
  }

  /**
   * Add a system-level info/error message to the chat.
   * Uses the 'assistant' role so it renders in the assistant style.
   */
  function addSystemMessage(content: string): void {
    const msg: ChatMessage = {
      id: generateMessageId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    messages = [...messages, msg];
    hasMessages = true;
    // a11y: these are error/system notices (voice offline, processing failed).
    // The conversation area is deliberately not a live region, and none of the
    // three call sites feed liveAnnouncement, so without this a screen-reader
    // user never hears that the request failed.
    liveAnnouncement = content;
  }

  // ─── Textarea auto-resize ────────────────────────────────────────────────────

  function handleInput(): void {
    isTyping = inputValue.trim().length > 0;
  }

  // ─── Send message ─────────────────────────────────────────────────────────────

  async function sendMessage(): Promise<void> {
    const text = inputValue.trim();
    if (!text || isThinking || isSpeaking) return;
    if (!dataConsented) return; // no processing before the explicit consent act

    // Snapshot the target conversation + generation, and stand up the abort
    // controller, all before any `await` — so a mid-send conversation switch
    // (resetChatState → _streamAbort.abort() + _activeGen++) can't make stale
    // tokens/persistence bleed into the newly-opened conversation.
    const convId = currentConversationId;
    // Retire a stream that is still in flight before taking over the shared
    // isThinking/isSpeaking flags. The guard at the top of this function normally
    // makes that impossible — but the safety timeout below can unlock the UI
    // while the request is still open, and an orphaned stream is not harmless:
    // the `finally` block only stands down when `streamSignal.aborted` is set,
    // so a straggler landing later would reset those flags and run its whole
    // persistence path against a message the user had already moved on from.
    _streamAbort?.abort();
    // Each send starts with no known failure reason — the previous one's is not
    // evidence about this one. `onFallback` sets it again if the mock takes over.
    fallbackInfo = null;
    const myAbort = new AbortController();
    _streamAbort = myAbort;
    const streamSignal = myAbort.signal;
    const myGen = _activeGen;

    // Add user message
    const userMsg: ChatMessage = {
      id: generateMessageId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    messages = [...messages, userMsg];
    inputValue = '';
    isTyping = false;
    hasMessages = true;

    // ➙ Save user message to Dexie IMMEDIATELY (best-effort — see persistMessage)
    await persistMessage(convId, {
      msgId: userMsg.id,
      role: 'user',
      content: text,
      timestamp: userMsg.timestamp,
    });
    if (streamSignal.aborted) return;

    // Reset textarea height
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }

    // Thinking state
    isThinking = true;

    // Build history for context (last 10 turns, truncated, filtered)
    const history = messages
      .slice(-11, -1)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.content.startsWith('⚠'))
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.slice(0, 2000),
      }));

    // Create assistant message shell (empty, will be filled by tokens).
    // `model` is filled by the stream's `onModel` event (router's E2B/E4B pick).
    const assistantMsg: ChatMessage = {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      model: undefined,
    };
    messages = [...messages, assistantMsg];
    const msgId = assistantMsg.id;

    // ➙ Save empty assistant message shell to Dexie IMMEDIATELY (best-effort)
    await persistMessage(convId, {
      msgId,
      role: 'assistant',
      content: '',
      timestamp: assistantMsg.timestamp,
    });
    if (streamSignal.aborted) return;

    // Stream tokens with safety timeout
    isSpeaking = true;
    isThinking = false;

    // Safety: if the stream hangs > 60s, RETIRE it — don't just unlock the UI.
    // Unlocking alone left the request open while telling the user it was over,
    // so a straggler that landed afterwards reset isThinking/isSpeaking and
    // wrote persistence for a message that was no longer current. Aborting is
    // what actually marks this generation dead: every guard downstream, and the
    // `finally` block, test `streamSignal.aborted`. The backend is cold-started
    // on demand, so this timer fires in ordinary use, not only on failure.
    const safetyTimeout = setTimeout(() => {
      if (isSpeaking) {
        console.warn('[SynapseTerminal] Safety timeout — retiring a stream that never finished');
        // Persist what did arrive first: aborting closes the `finally`
        // persistence path, and tokens are otherwise only written to Dexie on a
        // 500 ms throttle, so the tail would be lost from history.
        void flushStreamContent();
        myAbort.abort();
        isSpeaking = false;
        isThinking = false;
      }
    }, 60_000);

    // Set the moment the client tells us the mock is taking over, and read by
    // the token/done handlers below. Without it the badge lied: the mock's
    // reply is delivered through the ordinary onToken/onDone path, and both of
    // those set the badge to LIVE — so every scripted answer arrived under a
    // green "connected to the live inference server" label. The one state the
    // badge exists to report was the one it could not report.
    let answeredByMock = false;

    try {
      await synapseClient.chatStream(
        { message: text, history },
        {
          onModel(model: string) {
            if (streamSignal.aborted) return;
            // Tag this assistant message with the model that answered → badge.
            messages = messages.map((m) => (m.id === msgId ? { ...m, model } : m));
          },
          onFallback(info: FallbackInfo) {
            if (streamSignal.aborted) return;
            // Record WHY the mock is about to answer, so the badge tooltip can
            // stop claiming "backend unavailable" when the server in fact
            // replied 429/503. The badge text itself is unchanged: the mock
            // really is what produced the words on screen.
            fallbackInfo = info;
            answeredByMock = true;
            connectionSource = 'mock';
          },
          onToken(token: string) {
            // Guard: if stream was aborted mid-flight, ignore stale tokens
            if (streamSignal.aborted) return;
            // Append token to assistant message content (UI)
            messages = messages.map((m) =>
              m.id === msgId ? { ...m, content: m.content + token } : m
            );
            // Throttled save to Dexie (every 500ms)
            const updated = messages.find((m) => m.id === msgId);
            if (updated) {
              scheduleStreamSave(convId, msgId, updated.content);
            }
            connectionSource = answeredByMock ? 'mock' : 'live';
          },
          onDone(fullText: string) {
            if (streamSignal.aborted) return;
            isSpeaking = false;
            connectionSource = answeredByMock ? 'mock' : 'live';
            // Announce the finished reply once, politely (see liveAnnouncement).
            const done = messages.find((m) => m.id === msgId);
            liveAnnouncement = plainForSpeech(done?.content || fullText);
          },
          onError(err: string) {
            if (streamSignal.aborted) return;
            console.error('[SynapseTerminal] Stream error:', err);
            const fallback = t(uiLang, 'synapse.terminal.errConnectionError');
            messages = messages.map((m) =>
              m.id === msgId ? { ...m, content: m.content || fallback } : m
            );
            isSpeaking = false;
            connectionSource = 'mock';
            liveAnnouncement = plainForSpeech(
              messages.find((m) => m.id === msgId)?.content || fallback
            );
          },
        },
        streamSignal
      );
    } catch {
      if (!streamSignal.aborted) {
        isSpeaking = false;
        connectionSource = 'mock';
      }
    } finally {
      clearTimeout(safetyTimeout);
      // Only clean up if this controller is still the active one
      if (_streamAbort?.signal === streamSignal) {
        _streamAbort = null;
      }
      if (!streamSignal.aborted) {
        isThinking = false;
        isSpeaking = false;
        // Flush any pending stream content to Dexie
        await flushStreamContent();
        if (myGen !== _activeGen) return;
        // Final save of complete message to Dexie
        const finalMsg = messages.find((m) => m.id === msgId);
        if (finalMsg) {
          await updateMessageContent(convId, msgId, finalMsg.content);
        }
        if (myGen !== _activeGen) return;
        // Auto-title conversation from first user message
        await autoTitle(convId);
        if (myGen !== _activeGen) return;
        await refreshConversations();
        if (myGen !== _activeGen) return;
        // Background server push
        const conv = conversations.find((c) => c.id === convId);
        if (conv) {
          const storedMsgs = await dbGetMessages(convId);
          pushToServer(conv, storedMsgs);
        }
      }
    }
  }

  // ─── Keyboard handler for textarea ───────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ─── Typewriter effect ────────────────────────────────────────────────────────

  let typewriterTimer: ReturnType<typeof setTimeout> | null = null;
  let typewriterCancelled = false;

  function cancelTypewriter(): void {
    typewriterCancelled = true;
    if (typewriterTimer !== null) {
      clearTimeout(typewriterTimer);
      typewriterTimer = null;
    }
    isSpeaking = false;
    typewriterText = '';
    typewriterMsgId = '';
  }

  async function startTypewriter(msgId: string, text: string): Promise<void> {
    // Reduced-motion: show instantly
    if (reducedMotion) {
      typewriterMsgId = msgId;
      typewriterText = text;
      return;
    }

    typewriterCancelled = false;
    isSpeaking = true;
    typewriterMsgId = msgId;
    typewriterText = '';

    await new Promise<void>((resolve) => {
      let i = 0;

      function typeNext(): void {
        if (typewriterCancelled) {
          resolve();
          return;
        }

        if (i >= text.length) {
          isSpeaking = false;
          resolve();
          return;
        }

        typewriterText = text.slice(0, i + 1);
        i++;

        // 30-50ms per char — slight randomness for organic feel
        const delay = 28 + Math.random() * 22;
        typewriterTimer = setTimeout(typeNext, delay);
      }

      typeNext();
    });
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Render assistant message content.
   * Splits content into text and code-block segments for visual separation.
   * Returns array of {type: 'text'|'code', lang: string, content: string}.
   */
  function parseContent(
    content: string
  ): Array<{ type: 'text' | 'code'; lang: string; content: string }> {
    const parts: Array<{ type: 'text' | 'code'; lang: string; content: string }> = [];
    // Match fenced code blocks: ```lang\ncontent\n```
    const codeBlockRe = /```([^\n]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRe.exec(content)) !== null) {
      // Text before this code block
      if (match.index > lastIndex) {
        parts.push({ type: 'text', lang: '', content: content.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', lang: match[1].trim(), content: match[2] });
      lastIndex = codeBlockRe.lastIndex;
    }

    // Remaining text after last code block
    if (lastIndex < content.length) {
      parts.push({ type: 'text', lang: '', content: content.slice(lastIndex) });
    }

    return parts.length > 0 ? parts : [{ type: 'text', lang: '', content }];
  }

  /**
   * Render inline markdown-ish text.
   * Handles **bold** and `code` spans.
   * NOTE: sanitized — no raw HTML, only safe transformations.
   */
  // renderInline (the {@html} render-time XSS boundary) lives in
  // @/lib/synapse-render so it is unit-tested and can't be silently weakened.

  /**
   * Get displayed content for a message.
   * If this is the active typewriter message, return the typewriter slice.
   */
  function getDisplayContent(msg: ChatMessage): string {
    if (msg.role === 'assistant' && msg.id === typewriterMsgId) {
      return typewriterText;
    }
    return msg.content;
  }

  /**
   * Flattens a finished markdown reply into something a screen reader can read
   * aloud pleasantly: fenced code becomes the words "code block" (reading raw
   * code character-by-character is miserable aurally), inline markers are
   * stripped, whitespace collapsed. Used only for the aria-live announcement.
   */
  function plainForSpeech(md: string): string {
    return md
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/`/g, '') // strip any leftover backtick from an unterminated fence
      .replace(/[*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // TTS State
  let synthesizingMsgId = $state<string | null>(null);

  async function handleSynthesizeText(msg: ChatMessage) {
    if (synthesizingMsgId || isVoiceSpeaking || isSpeaking) return;
    try {
      synthesizingMsgId = msg.id;
      isVoiceSpeaking = true;
      startVoiceAmplitudeLoop();
      const audioBlob = await synapseClient.synthesizeText(msg.content);
      await audioEngine.playAudio(audioBlob);
    } catch (e) {
      console.error('TTS failed:', e);
    } finally {
      synthesizingMsgId = null;
      isVoiceSpeaking = false;
      stopVoiceAmplitudeLoop();
    }
  }

  /** Stop AI voice playback (called from stop button on message). */
  function handleStopPlayback(): void {
    if (!audioEngine) return;
    audioEngine.stopPlayback();
    isVoiceSpeaking = false;
    synthesizingMsgId = null;
    stopVoiceAmplitudeLoop();
  }

  // Orb size: 160px idle, shrinks to 80px when messages exist
  const orbSize = $derived(hasMessages ? 80 : 160);
</script>

<!-- ─── Overlay ──────────────────────────────────────────────────────────────── -->
<div
  bind:this={overlayEl}
  class="synapse-terminal"
  role="dialog"
  aria-modal="true"
  aria-label={t(uiLang, 'synapse.terminal.ariaTerminal')}
  style="opacity: 0; visibility: hidden;"
>
  <!-- Scanline texture overlay (decorative) -->
  <div class="scanlines" aria-hidden="true"></div>

  <!-- Corner decorations -->
  <div class="corner corner-tl" aria-hidden="true"></div>
  <div class="corner corner-tr" aria-hidden="true"></div>
  <div class="corner corner-bl" aria-hidden="true"></div>
  <div class="corner corner-br" aria-hidden="true"></div>

  <!-- Conversation history sidebar -->
  <SynapseSidebar
    open={sidebarOpen}
    {conversations}
    currentId={currentConversationId}
    {uiLang}
    onSelect={handleSelectConversation}
    onNew={handleNewChat}
    onRename={handleRenameConversation}
    onDelete={handleDeleteConversation}
    onClose={() => {
      sidebarOpen = false;
    }}
  />

  <!-- Hamburger button — conversation history sidebar toggle -->
  <button
    bind:this={hamburgerBtnEl}
    class="hamburger-btn"
    onclick={() => {
      sidebarOpen = !sidebarOpen;
    }}
    aria-label={t(uiLang, 'synapse.terminal.ariaToggleHistory')}
    aria-expanded={sidebarOpen}
    style="opacity: 0;"
  >
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 5h14M3 10h14M3 15h14"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  </button>

  <!-- Close button -->
  <button
    bind:this={closeBtnEl}
    class="close-btn"
    onclick={handleClose}
    aria-label={t(uiLang, 'synapse.terminal.ariaCloseTerminal')}
    style="opacity: 0;"
  >
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M15 5L5 15M5 5l10 10"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <span class="close-label">ESC</span>
  </button>

  <!-- Header wordmark -->
  <div class="terminal-header" aria-hidden="true">
    <span class="header-dot"></span>
    <span class="header-text">{t(uiLang, 'synapse.terminal.headerTitle')}</span>
    {#if connectionSource === 'live'}
      <span
        class="source-badge source-badge--live"
        title={t(uiLang, 'synapse.terminal.badgeLiveTitle')}
        >{t(uiLang, 'synapse.terminal.badgeLive')}</span
      >
    {:else if connectionSource === 'mock'}
      <span class="source-badge source-badge--mock" title={mockBadgeTitle}
        >{t(uiLang, 'synapse.terminal.badgeMock')}</span
      >
    {/if}
    <span class="header-dot"></span>
  </div>

  <!-- ── Orb area ────────────────────────────────────────────────────────────── -->
  <div
    bind:this={orbWrapEl}
    class="orb-section"
    class:orb-section--compact={hasMessages}
    style="opacity: 0; transform: scale(0);"
  >
    <SynapseOrb {orbState} size={orbSize} {audioAmplitude} />

    <!-- Status label below orb -->
    <div class="orb-status" aria-live="polite" aria-atomic="true">
      {#if isThinking}
        <span class="status-dot status-dot--thinking"></span>
        <span>{t(uiLang, 'synapse.terminal.statusProcessing')}</span>
      {:else if isVoiceSpeaking}
        <span class="status-dot status-dot--speaking"></span>
        <span>{t(uiLang, 'synapse.terminal.statusSpeaking')}</span>
      {:else if isSpeaking}
        <span class="status-dot status-dot--speaking"></span>
        <span>{t(uiLang, 'synapse.terminal.statusResponding')}</span>
      {:else if isVoiceRecording}
        <span class="status-dot status-dot--listening"></span>
        <span>{t(uiLang, 'synapse.terminal.statusRecording')}</span>
      {:else if isTyping}
        <span class="status-dot status-dot--listening"></span>
        <span>{t(uiLang, 'synapse.terminal.statusListening')}</span>
      {:else if !hasMessages}
        <span class="status-dot status-dot--idle"></span>
        <span>{t(uiLang, 'synapse.terminal.statusConnectionActive')}</span>
      {:else}
        <span class="status-dot status-dot--idle"></span>
        <span>{t(uiLang, 'synapse.terminal.statusIdle')}</span>
      {/if}
    </div>
  </div>

  <!-- Screen-reader announcer: the visible conversation below is deliberately
       NOT a live region (streaming tokens would spam partial sentences). The
       finished assistant reply is announced here once, politely. -->
  <div class="visually-hidden" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>

  <!-- ── Conversation area ────────────────────────────────────────────────────── -->
  <!-- role="region" (not "log"): a labelled landmark a screen-reader user can
       navigate into to re-read messages, WITHOUT auto-announcing every token.
       tabindex: the region scrolls (overflow-y: auto), and Chrome/Edge do NOT
       make scroll containers focusable on their own — without it a keyboard-only
       user cannot scroll back through the history (WCAG 2.1.1, axe
       "scrollable-region-focusable"). -1 while empty so it is not a dead stop. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={conversationEl}
    class="conversation"
    class:conversation--visible={hasMessages}
    role="region"
    tabindex={hasMessages ? 0 : -1}
    aria-label={t(uiLang, 'synapse.terminal.ariaConversationHistory')}
  >
    {#if !hasMessages}
      <!-- Empty state hint -->
      <div class="empty-hint" aria-hidden="true">
        <p class="empty-hint__text">
          {t(uiLang, 'synapse.terminal.emptyStateText')}
        </p>
        <p class="empty-hint__disclaimer">{t(uiLang, 'synapse.disclaimer')}</p>
        <div class="empty-hint__suggestions">
          <button
            class="suggestion-chip"
            onclick={() => {
              inputValue = t(uiLang, 'synapse.terminal.suggestionStack');
              isTyping = true;
            }}
          >
            {t(uiLang, 'synapse.terminal.suggestionStack')}
          </button>
          <button
            class="suggestion-chip"
            onclick={() => {
              inputValue = t(uiLang, 'synapse.terminal.suggestionAbout');
              isTyping = true;
            }}
          >
            {t(uiLang, 'synapse.terminal.suggestionAbout')}
          </button>
          <button
            class="suggestion-chip"
            onclick={() => {
              inputValue = t(uiLang, 'synapse.terminal.suggestionRag');
              isTyping = true;
            }}
          >
            {t(uiLang, 'synapse.terminal.suggestionRag')}
          </button>
        </div>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      {#if msg.role === 'user'}
        <!-- User message -->
        <div class="msg msg--user" aria-label={t(uiLang, 'synapse.terminal.ariaYouSaid')}>
          <span class="msg-prompt" aria-hidden="true">&gt;</span>
          <span class="msg-content msg-content--user">{msg.content}</span>
        </div>
      {:else}
        <!-- Assistant message -->
        {@const displayContent = getDisplayContent(msg)}
        {@const isActive = msg.id === typewriterMsgId}
        {@const badge = modelBadge(msg.model)}

        <div
          class="msg msg--assistant"
          class:msg--typing={isActive && isSpeaking}
          aria-label={t(uiLang, 'synapse.terminal.ariaSynapseResponse')}
        >
          {#each parseContent(displayContent) as part}
            {#if part.type === 'code'}
              <div class="code-block">
                {#if part.lang}
                  <span class="code-lang">{part.lang}</span>
                {/if}
                <pre class="code-pre"><code>{part.content}</code></pre>
              </div>
            {:else}
              <!-- Text part: render paragraphs split by \n\n -->
              {#each part.content.split('\n\n') as para, pi}
                {#if para.trim()}
                  <p class="msg-para" class:first-para={pi === 0}>
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html renderInline(para)}
                  </p>
                {/if}
              {/each}
            {/if}
          {/each}

          <!-- Cursor blink when typing -->
          {#if isActive && isSpeaking}
            <span class="typewriter-cursor" aria-hidden="true">▋</span>
          {/if}

          <!-- Per-message model badge (router's E2B/E4B pick, or mock) -->
          {#if badge && (!isActive || !isSpeaking)}
            <span class="model-badge {badge.cls}" title={badge.title}>{badge.label}</span>
          {/if}

          <!-- TTS / Stop Button -->
          {#if !isActive || !isSpeaking}
            {#if isVoiceSpeaking && synthesizingMsgId === msg.id}
              <!-- STOP button (replaces speaker during playback) -->
              <button
                class="msg-tts-btn msg-tts-btn--stop"
                onclick={handleStopPlayback}
                aria-label={t(uiLang, 'synapse.terminal.stopPlayback')}
                title={t(uiLang, 'synapse.terminal.stopPlayback')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                </svg>
              </button>
            {:else}
              <button
                class="msg-tts-btn"
                class:msg-tts-btn--loading={synthesizingMsgId === msg.id}
                disabled={synthesizingMsgId !== null || isVoiceSpeaking || isSpeaking}
                onclick={() => handleSynthesizeText(msg)}
                aria-label={t(uiLang, 'synapse.terminal.readAloud')}
                title={t(uiLang, 'synapse.terminal.readAloud')}
              >
                {#if synthesizingMsgId === msg.id}
                  <!-- Loading spinner -->
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    class="tts-spinner"
                    aria-hidden="true"
                  >
                    <path
                      d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                {:else}
                  <!-- Speaker icon -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M11 5L6 9H2v6h4l5 4V5z"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                {/if}
              </button>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}

    <!-- Thinking indicator -->
    {#if isThinking}
      <div
        class="thinking-indicator"
        aria-label={t(uiLang, 'synapse.terminal.ariaThinking')}
        aria-live="polite"
      >
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
      </div>
    {/if}
  </div>

  {#if !dataConsented}
    <!-- Consent gate: shown until the one-time explicit act (see the state
         block for the legal reasoning). Static on purpose — no entrance
         tween: the thing asking for consent should not be the thing moving. -->
    <div class="consent-bar" role="region" aria-label={t(uiLang, 'synapse.terminal.consentAria')}>
      <div class="consent-bar__card">
        <p class="consent-bar__text">
          {t(uiLang, 'synapse.terminal.consentText')}
          <a href={`/${uiLang}/privacy/`} target="_blank" rel="noopener"
            >{t(uiLang, 'synapse.terminal.consentLinkLabel')}</a
          >.
        </p>
        <button class="consent-bar__agree" onclick={grantDataConsent}>
          {t(uiLang, 'synapse.terminal.consentAgree')}
        </button>
      </div>
    </div>
  {/if}

  <!-- ── Input Bar ─────────────────────────────────────────────────────────── -->
  <div bind:this={inputBarEl} class="input-bar" style="opacity: 0; transform: translateY(60px);">
    {#if STT_AVAILABLE}
      <!-- Mic button — voice input. Gated on STT_AVAILABLE above. -->
      <button
        class="mic-btn"
        class:mic-btn--recording={isVoiceRecording}
        aria-label={isVoiceRecording
          ? t(uiLang, 'synapse.terminal.micStopRecording')
          : t(uiLang, 'synapse.terminal.micStartVoiceInput')}
        title={isVoiceRecording
          ? t(uiLang, 'synapse.terminal.micTitleStop')
          : t(uiLang, 'synapse.terminal.micTitleStart')}
        disabled={isThinking || isVoiceSpeaking || !dataConsented}
        onclick={handleMicClick}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M5 10a7 7 0 0014 0"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <line
            x1="12"
            y1="19"
            x2="12"
            y2="22"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <line
            x1="9"
            y1="22"
            x2="15"
            y2="22"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        {#if isVoiceRecording}
          <span class="mic-recording-label" aria-live="polite">REC</span>
        {/if}
      </button>
    {/if}

    <!-- Text input -->
    <textarea
      bind:this={textareaEl}
      bind:value={inputValue}
      class="input-textarea"
      placeholder={t(uiLang, 'synapse.terminal.inputPlaceholder')}
      rows="1"
      aria-label={t(uiLang, 'synapse.terminal.ariaMessageInput')}
      aria-multiline="true"
      onkeydown={handleKeydown}
      oninput={handleInput}
      disabled={isThinking || isSpeaking || !dataConsented}
    ></textarea>

    <!-- Send button -->
    <button
      class="send-btn"
      class:send-btn--active={inputValue.trim().length > 0 &&
        !isThinking &&
        !isSpeaking &&
        dataConsented}
      onclick={sendMessage}
      disabled={inputValue.trim().length === 0 || isThinking || isSpeaking || !dataConsented}
      aria-label={t(uiLang, 'synapse.terminal.ariaSendMessage')}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 12h14M13 6l6 6-6 6"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  <!-- Persistent honesty disclaimer — the model is self-hosted and still in training -->
  <p class="synapse-disclaimer" role="note">{t(uiLang, 'synapse.disclaimerShort')}</p>
</div>

<style>
  /* ── Overlay ──────────────────────────────────────────────────────────────── */
  .synapse-terminal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: hsla(220, 25%, 6%, 0.85);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid hsla(185, 80%, 60%, 0.08);

    /* Subtle grid background for neural aesthetic */
    background-image:
      linear-gradient(hsla(185, 80%, 60%, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, hsla(185, 80%, 60%, 0.03) 1px, transparent 1px);
    background-size: 40px 40px;

    overflow: hidden;
    padding: 0;

    /* Vignette */
    --vignette: radial-gradient(ellipse at center, transparent 55%, hsla(220, 30%, 4%, 0.6) 100%);
  }

  .synapse-terminal::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--vignette);
    pointer-events: none;
    z-index: 0;
  }

  /* Scanlines */
  .scanlines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      hsla(0, 0%, 0%, 0.04) 2px,
      hsla(0, 0%, 0%, 0.04) 4px
    );
  }

  /* ── Corner decorations ───────────────────────────────────────────────────── */
  .corner {
    position: absolute;
    width: 24px;
    height: 24px;
    z-index: 2;
    pointer-events: none;
  }

  .corner::before,
  .corner::after {
    content: '';
    position: absolute;
    background: hsla(185, 80%, 60%, 0.5);
  }

  .corner::before {
    width: 100%;
    height: 1.5px;
    top: 0;
  }
  .corner::after {
    width: 1.5px;
    height: 100%;
    top: 0;
  }

  /* All chrome offsets add env(safe-area-inset-*): the terminal is a fixed
     inset:0 panel over a viewport-fit=cover page, so in the installed PWA
     flat offsets land in the status-bar / home-indicator strips. env() is
     0px everywhere that has no notch. */
  .corner-tl {
    top: calc(20px + env(safe-area-inset-top, 0px));
    left: calc(20px + env(safe-area-inset-left, 0px));
  }
  .corner-tr {
    top: calc(20px + env(safe-area-inset-top, 0px));
    right: calc(20px + env(safe-area-inset-right, 0px));
    transform: scaleX(-1);
  }
  .corner-bl {
    bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    left: calc(20px + env(safe-area-inset-left, 0px));
    transform: scaleY(-1);
  }
  .corner-br {
    bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    right: calc(20px + env(safe-area-inset-right, 0px));
    transform: scale(-1);
  }

  /* ── Close button ─────────────────────────────────────────────────────────── */
  .close-btn {
    position: absolute;
    top: calc(20px + env(safe-area-inset-top, 0px));
    right: calc(20px + env(safe-area-inset-right, 0px));
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px 8px 10px;
    background: hsla(220, 25%, 10%, 0.6);
    border: 1px solid hsla(185, 80%, 60%, 0.15);
    border-radius: 8px;
    color: hsla(185, 10%, 65%, 0.7);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition:
      color 200ms ease,
      border-color 200ms ease,
      background 200ms ease;
  }

  .close-btn:hover {
    color: hsla(185, 80%, 70%, 0.95);
    border-color: hsla(185, 80%, 60%, 0.4);
    background: hsla(185, 40%, 12%, 0.6);
  }

  .close-label {
    text-transform: uppercase;
    font-weight: 500;
  }

  /* ── Hamburger button (sidebar toggle) ──────────────────────────────────── */
  .hamburger-btn {
    position: absolute;
    top: calc(20px + env(safe-area-inset-top, 0px));
    left: calc(20px + env(safe-area-inset-left, 0px));
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 36px;
    background: hsla(220, 25%, 10%, 0.6);
    border: 1px solid hsla(185, 80%, 60%, 0.15);
    border-radius: 8px;
    color: hsla(185, 10%, 65%, 0.7);
    cursor: pointer;
    transition:
      color 200ms ease,
      border-color 200ms ease,
      background 200ms ease,
      box-shadow 200ms ease;
  }

  .hamburger-btn:hover {
    color: #00ffd5;
    border-color: hsla(175, 80%, 50%, 0.4);
    background: hsla(175, 40%, 12%, 0.6);
    box-shadow: 0 0 14px hsla(175, 80%, 50%, 0.12);
  }

  /* ── Header ───────────────────────────────────────────────────────────────── */
  .terminal-header {
    position: relative;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 24px 0 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.2em;
    color: hsla(185, 80%, 60%, 0.35);
    text-transform: uppercase;
    user-select: none;
  }

  /* ── Source badge (LIVE / MOCK) ────────────────────────────────────────────── */
  .source-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    border: 1px solid currentColor;
    opacity: 0.85;
    animation: badge-appear 300ms ease-out both;
  }

  @keyframes badge-appear {
    from {
      opacity: 0;
      transform: scale(0.8);
    }
    to {
      opacity: 0.85;
      transform: scale(1);
    }
  }

  .source-badge--live {
    color: hsl(155, 60%, 50%);
    background: hsla(155, 60%, 50%, 0.08);
    border-color: hsla(155, 60%, 50%, 0.4);
  }

  .source-badge--mock {
    color: hsl(35, 80%, 60%);
    background: hsla(35, 80%, 60%, 0.08);
    border-color: hsla(35, 80%, 60%, 0.4);
  }

  /* ── Per-message model badge (router E2B/E4B, or mock) ── */
  .model-badge {
    display: inline-flex;
    align-items: center;
    margin-top: 8px;
    padding: 1px 7px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    animation: badge-appear 300ms ease-out both;
    user-select: none;
  }

  /* E2B = "junior" → blue accent; E4B = "mid" → green accent (design tokens). */
  .model-badge--e2b {
    color: var(--accent-blue-200);
    background: var(--accent-blue-glow);
    border-color: var(--accent-blue-300);
  }

  .model-badge--e4b {
    color: var(--accent-green-200);
    background: var(--accent-glow);
    border-color: var(--accent-green-300);
  }

  .model-badge--mock {
    color: var(--color-warning);
    background: hsla(40, 90%, 55%, 0.1);
    border-color: hsla(40, 90%, 55%, 0.4);
  }

  .header-dot {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: hsla(185, 80%, 60%, 0.4);
    animation: header-pulse 2.4s ease-in-out infinite;
  }

  .header-dot:last-child {
    animation-delay: 1.2s;
  }

  @keyframes header-pulse {
    0%,
    100% {
      opacity: 0.3;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.4);
    }
  }

  /* ── Orb section ──────────────────────────────────────────────────────────── */
  .orb-section {
    position: relative;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 0 16px;
    flex-shrink: 0;
    transition: padding 400ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .orb-section--compact {
    padding: 16px 0 8px;
  }

  /* Orb ambient glow ring */
  .orb-section::before {
    content: '';
    position: absolute;
    width: 240px;
    height: 240px;
    border-radius: 50%;
    background: radial-gradient(circle, hsla(185, 80%, 60%, 0.04) 0%, transparent 70%);
    pointer-events: none;
    transition: opacity 600ms ease;
  }

  .orb-section--compact::before {
    width: 140px;
    height: 140px;
    opacity: 0.6;
  }

  /* ── Orb status label ─────────────────────────────────────────────────────── */
  .orb-status {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.12em;
    color: hsla(185, 15%, 60%, 0.55);
    text-transform: uppercase;
    user-select: none;
  }

  .status-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot--idle {
    background: hsla(185, 80%, 60%, 0.5);
  }
  .status-dot--listening {
    background: hsl(155, 60%, 50%);
    animation: status-pulse 1s ease-in-out infinite;
  }
  .status-dot--thinking {
    background: hsl(195, 20%, 85%);
    animation: status-pulse 0.5s ease-in-out infinite;
  }
  .status-dot--speaking {
    background: hsla(185, 80%, 60%, 0.9);
    animation: status-pulse 0.8s ease-in-out infinite;
  }

  @keyframes status-pulse {
    0%,
    100% {
      opacity: 0.5;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.5);
    }
  }

  /* ── Conversation ─────────────────────────────────────────────────────────── */
  .conversation {
    position: relative;
    z-index: 5;
    flex: 1;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 0 clamp(1rem, 4vw, 2.5rem) 80px; /* added 80px bottom padding */
    overflow-y: auto;
    overflow-x: hidden;

    /* Custom scrollbar */
    scrollbar-width: thin;
    scrollbar-color: hsla(185, 80%, 60%, 0.3) transparent;

    /* Fade top edge only — bottom stays fully visible for last message */
    mask-image: linear-gradient(to bottom, transparent 0%, black 3%, black 100%);
  }

  .conversation::-webkit-scrollbar {
    width: 4px;
  }

  .conversation::-webkit-scrollbar-track {
    background: transparent;
  }

  .conversation::-webkit-scrollbar-thumb {
    background: hsla(185, 80%, 60%, 0.3);
    border-radius: 999px;
  }

  /* ── Empty hint ───────────────────────────────────────────────────────────── */
  .empty-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: 20px 0;
    text-align: center;
  }

  .empty-hint__text {
    font-family: 'Inter', sans-serif;
    font-size: 0.875rem;
    color: hsla(185, 15%, 55%, 0.5);
    line-height: 1.6;
    max-width: 380px;
  }

  /* Honesty disclaimer — model still in training (warning-amber convention) */
  .empty-hint__disclaimer {
    max-width: 420px;
    margin-top: 4px;
    padding: 8px 14px;
    border: 1px solid hsla(40, 90%, 55%, 0.3);
    border-radius: var(--radius-md);
    background: hsla(40, 90%, 55%, 0.08);
    color: hsl(40, 90%, 68%);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .empty-hint__suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .suggestion-chip {
    padding: 7px 14px;
    background: hsla(185, 30%, 10%, 0.5);
    border: 1px solid hsla(185, 80%, 60%, 0.12);
    border-radius: 999px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: hsla(185, 20%, 65%, 0.7);
    cursor: pointer;
    transition:
      color 200ms ease,
      border-color 200ms ease,
      background 200ms ease;
  }

  .suggestion-chip:hover {
    color: hsla(185, 80%, 70%, 0.95);
    border-color: hsla(185, 80%, 60%, 0.35);
    background: hsla(185, 40%, 12%, 0.5);
  }

  /* ── Messages ─────────────────────────────────────────────────────────────── */
  .msg {
    margin-bottom: 16px;
    animation: msg-appear 200ms ease-out both;
  }

  @keyframes msg-appear {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* User message */
  .msg--user {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 0;
  }

  .msg-prompt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: hsla(185, 80%, 60%, 0.4);
    flex-shrink: 0;
    margin-top: 1px;
    user-select: none;
    font-size: 0.95rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    position: relative;
  }

  .msg-tts-btn {
    position: absolute;
    bottom: -10px;
    right: -10px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    /* NOTE: this block used to reference --color-bg-elevated / --color-border /
       --color-text-dim, none of which exist in the design system (grep over
       src/ finds no definition). `border: 1px solid var(--undefined)` is invalid
       at computed-value time → border-style fell back to `none`, and the
       background to `transparent`, so the chip rendered as a bare icon.
       Re-pointed at the terminal's own palette (same recipe as .mic-btn/.send-btn). */
    background: hsla(220, 25%, 10%, 0.9);
    border: 1px solid hsla(185, 80%, 60%, 0.25);
    color: hsla(185, 20%, 75%, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
    opacity: 0;
    transform: scale(0.8);
  }

  /* a11y: the button used to appear on parent hover ONLY. It stayed in the tab
     order at opacity 0 (focus trap filters by offsetParent, which opacity does
     not clear), so a keyboard user could land on an invisible control — and on a
     touch screen, where :hover never fires, it was invisible but tappable.
     :focus-within/:focus-visible reveal it for the keyboard; see the
     `(hover: none)` block below for touch. */
  .msg--assistant:hover .msg-tts-btn,
  .msg--assistant:focus-within .msg-tts-btn,
  .msg-tts-btn:focus-visible {
    opacity: 1;
    transform: scale(1);
  }

  .msg-tts-btn:hover:not(:disabled) {
    background: hsla(185, 40%, 14%, 0.9);
    color: hsl(185, 80%, 75%);
    border-color: hsla(185, 80%, 60%, 0.6);
  }

  /* Touch / coarse pointers: hover can never reveal the button, so keep it
     visible, and grow the hit area to 44×44 (28 + 8px on each side) with a
     transparent pseudo-element — the 28px visual size is unchanged. */
  @media (hover: none) {
    .msg-tts-btn {
      opacity: 1;
      transform: scale(1);
    }

    .msg-tts-btn::after {
      content: '';
      position: absolute;
      inset: -8px;
      border-radius: 50%;
    }
  }

  .msg-tts-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .msg-tts-btn--stop {
    opacity: 1 !important;
    color: hsl(35, 90%, 60%);
    border-color: hsla(35, 90%, 60%, 0.4);
    animation: tts-stop-pulse 1s ease-in-out infinite;
  }

  .msg-tts-btn--stop:hover {
    color: hsl(35, 90%, 70%);
    background: hsla(35, 40%, 15%, 0.6);
    border-color: hsla(35, 90%, 60%, 0.6);
  }

  @keyframes tts-stop-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 hsla(35, 90%, 60%, 0.3);
    }
    50% {
      box-shadow: 0 0 0 4px hsla(35, 90%, 60%, 0);
    }
  }

  .tts-spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .msg-content--user {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: hsla(185, 10%, 65%, 0.7);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Assistant message */
  .msg--assistant {
    /* Containing block for .msg-tts-btn. Without it the button anchors to
       .conversation (position: relative) instead of its own message: normally
       the `msg-appear` animation's transform happens to create the containing
       block, but the reduced-motion block below kills that transform, and then
       every speaker button piles up in one corner of the scroll area. */
    position: relative;
    padding: 14px 0 14px 16px;
    border-left: 2px solid hsla(185, 80%, 60%, 0.25);
    background: hsla(185, 30%, 8%, 0.2);
    border-radius: 0 8px 8px 0;
    margin-left: 4px;
    transition: border-color 300ms ease;
  }

  .msg--assistant.msg--typing {
    border-left-color: hsla(185, 80%, 60%, 0.5);
  }

  /* Paragraph inside assistant message */
  .msg-para {
    font-family: 'Inter', sans-serif;
    font-size: 1rem;
    color: hsla(185, 20%, 85%, 0.95);
    line-height: 1.7;
    margin: 0;
    word-break: break-word;
  }

  .msg-para + .msg-para,
  .msg-para + .code-block,
  .code-block + .msg-para {
    margin-top: 12px;
  }

  /* Bold inline */
  .msg-para :global(strong) {
    color: hsla(185, 80%, 70%, 0.95);
    font-weight: 600;
  }

  /* Inline code */
  .msg-para :global(.inline-code) {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.875em;
    color: hsla(185, 80%, 70%, 0.9);
    background: hsla(185, 30%, 10%, 0.6);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid hsla(185, 80%, 60%, 0.12);
  }

  /* Italic inline */
  .msg-para :global(em) {
    font-style: italic;
    color: hsla(185, 25%, 88%, 0.95);
  }

  /* Headings (## …  or model <h2>) — rendered as a distinct block line */
  .msg-para :global(.msg-heading) {
    display: block;
    font-weight: 700;
    font-size: 1.06em;
    letter-spacing: 0.01em;
    color: hsla(185, 80%, 74%, 0.98);
    margin: 12px 0 4px;
  }
  .msg-para :global(.msg-heading:first-child) {
    margin-top: 0;
  }

  /* Bullet lines (-, • , or model <li>) */
  .msg-para :global(.msg-bullet) {
    display: block;
    position: relative;
    padding-left: 1.15em;
    margin: 2px 0;
  }
  .msg-para :global(.msg-bullet)::before {
    content: '▹';
    position: absolute;
    left: 0;
    color: hsla(185, 80%, 65%, 0.7);
  }

  /* ── Code blocks ──────────────────────────────────────────────────────────── */
  .code-block {
    position: relative;
    background: hsla(220, 25%, 10%, 0.8);
    border: 1px solid hsla(185, 80%, 60%, 0.1);
    border-radius: 6px;
    overflow: hidden;
  }

  .code-lang {
    display: block;
    padding: 5px 12px 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: hsla(185, 80%, 60%, 0.5);
    background: hsla(185, 30%, 8%, 0.4);
    border-bottom: 1px solid hsla(185, 80%, 60%, 0.08);
    user-select: none;
  }

  .code-pre {
    margin: 0;
    padding: 12px 14px;
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: hsla(185, 80%, 60%, 0.2) transparent;
  }

  .code-pre code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
    line-height: 1.65;
    color: hsla(185, 20%, 82%, 0.92);
    white-space: pre;
  }

  /* ── Typewriter cursor ────────────────────────────────────────────────────── */
  .typewriter-cursor {
    display: inline-block;
    color: hsla(185, 80%, 60%, 0.8);
    animation: cursor-blink 0.6s step-end infinite;
    font-size: 0.9em;
    margin-left: 1px;
    vertical-align: baseline;
  }

  @keyframes cursor-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  /* ── Thinking indicator ───────────────────────────────────────────────────── */
  .thinking-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0 8px 16px;
    margin-bottom: 8px;
  }

  .thinking-dot {
    display: block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: hsla(185, 80%, 60%, 0.5);
    animation: thinking-bounce 1.2s ease-in-out infinite;
  }

  .thinking-dot:nth-child(2) {
    animation-delay: 0.2s;
  }
  .thinking-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes thinking-bounce {
    0%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }
    40% {
      opacity: 1;
      transform: translateY(-4px);
    }
  }

  /* ── Input bar ────────────────────────────────────────────────────────────── */
  /* ── Consent gate ─────────────────────────────────────────────────── */
  .consent-bar {
    position: relative;
    z-index: 6;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 0 clamp(1rem, 4vw, 2.5rem);
  }

  .consent-bar__card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
  }

  .consent-bar__text {
    margin: 0;
    flex: 1 1 24ch;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .consent-bar__text a {
    color: var(--accent-green-300);
    text-decoration: underline;
  }

  /* 44px floor: this is the one control a first-time visitor MUST hit. */
  .consent-bar__agree {
    min-height: 44px;
    padding: 0 var(--space-4);
    border: 1px solid var(--accent-green-400);
    border-radius: var(--radius-md);
    background: none;
    color: var(--accent-green-300);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: var(--transition-colors);
  }

  .consent-bar__agree:hover,
  .consent-bar__agree:focus-visible {
    color: var(--accent-green-200);
    border-color: var(--accent-green-300);
  }

  .input-bar {
    position: relative;
    z-index: 5;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    /* + env(): keep the mic/send row above the home-indicator swipe strip. */
    padding: clamp(12px, 2vh, 20px) clamp(1rem, 4vw, 2.5rem)
      calc(clamp(16px, 3vh, 28px) + env(safe-area-inset-bottom, 0px));
    display: flex;
    align-items: flex-end;
    gap: 10px;
  }

  .input-bar::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, hsla(220, 25%, 6%, 0.6), transparent);
    pointer-events: none;
    z-index: -1;
  }

  /* Persistent honesty disclaimer under the input — always visible while chatting */
  .synapse-disclaimer {
    position: relative;
    z-index: 5;
    width: 100%;
    max-width: 760px;
    margin: -6px auto 0;
    padding: 0 clamp(1rem, 4vw, 2.5rem) clamp(10px, 2vh, 16px);
    text-align: center;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1.4;
    letter-spacing: var(--tracking-wide);
    color: hsla(40, 90%, 66%, 0.75);
  }

  /* Inner bar container */
  .input-bar > * {
    /* children sit above the gradient */
    position: relative;
  }

  /* The actual input row */
  .mic-btn,
  .input-textarea,
  .send-btn {
    background: hsla(220, 25%, 10%, 0.6);
    border: 1px solid hsla(185, 80%, 60%, 0.15);
    border-radius: 12px;
    color: hsla(185, 20%, 75%, 0.9);
    transition:
      border-color 200ms ease,
      background 200ms ease,
      color 200ms ease;
  }

  /* Mic button */
  .mic-btn {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    opacity: 0.75;
    border-radius: 12px;
    position: relative;
    transition:
      color 200ms ease,
      border-color 200ms ease,
      background 200ms ease,
      opacity 200ms ease,
      box-shadow 200ms ease;
  }

  .mic-btn:hover:not(:disabled) {
    opacity: 1;
    color: hsla(185, 80%, 70%, 0.95);
    border-color: hsla(185, 80%, 60%, 0.35);
    background: hsla(185, 40%, 12%, 0.6);
  }

  .mic-btn:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }

  /* Recording state */
  .mic-btn--recording {
    color: hsl(0, 70%, 60%);
    border-color: hsla(0, 70%, 60%, 0.4);
    opacity: 1;
    animation: mic-pulse 1.5s ease-in-out infinite;
  }

  .mic-btn--recording:hover {
    color: hsl(0, 70%, 65%);
    border-color: hsla(0, 70%, 60%, 0.6);
    background: hsla(0, 40%, 12%, 0.6);
  }

  /* Stop playback state */
  .mic-btn--stop {
    color: hsl(35, 90%, 60%);
    border-color: hsla(35, 90%, 60%, 0.4);
    opacity: 1;
    animation: mic-pulse-stop 1s ease-in-out infinite;
  }

  .mic-btn--stop:hover {
    color: hsl(35, 90%, 70%);
    border-color: hsla(35, 90%, 60%, 0.6);
    background: hsla(35, 40%, 12%, 0.6);
  }

  @keyframes mic-pulse-stop {
    0%,
    100% {
      box-shadow: 0 0 0 0 hsla(35, 90%, 60%, 0.3);
    }
    50% {
      box-shadow: 0 0 0 6px hsla(35, 90%, 60%, 0);
    }
  }

  @keyframes mic-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 hsla(0, 70%, 60%, 0.4);
    }
    50% {
      box-shadow: 0 0 0 8px hsla(0, 70%, 60%, 0);
    }
  }

  /* Tiny REC label inside mic button when recording */
  .mic-recording-label {
    position: absolute;
    bottom: 3px;
    right: 3px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.42rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: hsl(0, 70%, 70%);
    line-height: 1;
    user-select: none;
    pointer-events: none;
  }

  /* Textarea */
  .input-textarea {
    flex: 1;
    height: 44px;
    padding: 11px 14px;
    font-family: 'Inter', sans-serif;
    font-size: 0.9rem;
    line-height: 1.5;
    color: hsla(185, 20%, 85%, 0.95);
    resize: none;
    outline: none;
    background: hsla(220, 25%, 10%, 0.6);
    scrollbar-width: thin;
    scrollbar-color: hsla(185, 80%, 60%, 0.2) transparent;
  }

  .input-textarea::placeholder {
    color: hsla(185, 10%, 50%, 0.45);
    font-style: italic;
  }

  /* a11y (WCAG 1.4.11 / 2.4.7): this rule used to carry `outline: none`, which
     out-ranked the global :focus-visible ring (global.css) — and the only
     replacement indicator, a border at alpha .35, measures 2.40:1 against the
     field background (3:1 required). Border alpha raised to .70 → 5.94:1 vs the
     field, 6.36:1 vs the bar behind it, so even a pointer focus is visible. */
  .input-textarea:focus {
    border-color: hsla(185, 80%, 60%, 0.7);
    background: hsla(220, 25%, 11%, 0.7);
  }

  /* Keyboard focus gets a real ring, in the terminal's own cyan (opaque:
     11.8:1 against the input bar). Declared locally so that component-scoped
     specificity can never leave the field without a ring again — same recipe
     as SynapseSidebar's .conv-rename-input:focus-visible. */
  .input-textarea:focus-visible {
    outline: 2px solid hsl(185, 80%, 60%);
    outline-offset: 2px;
  }

  .input-textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Send button */
  .send-btn {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: not-allowed;
    opacity: 0.35;
    border-radius: 12px;
    transition:
      border-color 200ms ease,
      background 200ms ease,
      color 200ms ease,
      opacity 200ms ease,
      box-shadow 200ms ease;
  }

  .send-btn--active {
    opacity: 1;
    cursor: pointer;
    color: hsla(185, 80%, 70%, 0.95);
    border-color: hsla(185, 80%, 60%, 0.35);
  }

  .send-btn--active:hover {
    border-color: hsla(185, 80%, 60%, 0.6);
    background: hsla(185, 40%, 12%, 0.6);
    box-shadow: 0 0 16px hsla(185, 80%, 60%, 0.15);
    color: hsl(185, 80%, 75%);
  }

  .send-btn--active:active {
    transform: scale(0.95);
  }

  /* ── Reduced-motion overrides ──────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .header-dot,
    .status-dot--listening,
    .status-dot--thinking,
    .status-dot--speaking,
    .typewriter-cursor,
    .thinking-dot,
    .mic-btn--recording,
    .msg-tts-btn--stop,
    .tts-spinner {
      /* .msg-tts-btn--stop (infinite pulse) and .tts-spinner (infinite spin)
         were the two ungated animations left in this file. Both keep a static
         end state: the stop button keeps its amber border, the spinner its
         icon. */
      animation: none !important;
    }

    .mic-btn--recording {
      box-shadow: 0 0 0 2px hsla(0, 70%, 60%, 0.5) !important;
    }

    .msg {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }

    .orb-section {
      transition: none !important;
    }
  }

  /* ── Responsive ────────────────────────────────────────────────────────────── */
  @media (max-width: 640px) {
    .terminal-header {
      font-size: 0.55rem;
      padding-top: 16px;
    }

    .close-btn {
      top: calc(12px + env(safe-area-inset-top, 0px));
      right: calc(12px + env(safe-area-inset-right, 0px));
    }

    .hamburger-btn {
      top: calc(12px + env(safe-area-inset-top, 0px));
      left: calc(12px + env(safe-area-inset-left, 0px));
    }

    .corner {
      width: 16px;
      height: 16px;
    }

    .corner-tl {
      top: calc(12px + env(safe-area-inset-top, 0px));
      left: calc(12px + env(safe-area-inset-left, 0px));
    }
    .corner-tr {
      top: calc(12px + env(safe-area-inset-top, 0px));
      right: calc(12px + env(safe-area-inset-right, 0px));
    }
    .corner-bl {
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      left: calc(12px + env(safe-area-inset-left, 0px));
    }
    .corner-br {
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      right: calc(12px + env(safe-area-inset-right, 0px));
    }
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it away.
     Measured in dist: the minifier collapses `backdrop-filter` into its -webkit-
     alias and drops the standard declaration, so Firefox renders this overlay as
     a flat fill. It does not collapse across an @supports boundary. Must stay
     AFTER the base rule — equal specificity, last one wins. */
  @supports (backdrop-filter: blur(1px)) {
    .synapse-terminal {
      backdrop-filter: blur(20px) saturate(180%);
    }
  }
</style>
