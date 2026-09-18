<script lang="ts">
  /**
   * SynapseAccount.svelte
   * ───────────────────────────────────────────────────────────────────────────
   * Sidebar-footer account row: Google sign-in ⇄ signed-in profile.
   *
   * Encapsulates ALL Google Identity Services (GIS) UI + reactivity so the rest
   * of the terminal stays auth-agnostic. Signing in is what unlocks server-side,
   * cross-device chat history; anonymous visitors stay local-only (IndexedDB).
   *
   * Renders NOTHING when no OAuth client id is configured (authConfigured() =
   * false) — the site works offline / before the owner provisions a client id.
   */
  import { onMount } from 'svelte';
  import { t, type Lang } from '@/i18n/utils';
  import {
    authConfigured,
    renderSignInButton,
    signOut,
    onAuthChange,
    isSignedIn,
    getProfile,
    type SynapseProfile,
  } from '@/lib/auth';

  interface Props {
    uiLang: Lang;
    /** Whether the containing sidebar is (or has been) open. Google Identity
     *  Services is only loaded once this is true, so a visitor who never opens
     *  Synapse never pays the third-party `gsi/client` fetch (perf + privacy). */
    active?: boolean;
  }
  const { uiLang, active = false }: Props = $props();

  const configured = authConfigured();

  let signedIn = $state(isSignedIn());
  let profile = $state<SynapseProfile | null>(getProfile());
  let buttonEl = $state<HTMLDivElement | undefined>();
  let avatarBroken = $state(false);

  onMount(() => {
    if (!configured) return;
    // Subscribe only — cheap, no network. GIS itself is loaded lazily below.
    const off = onAuthChange(() => {
      signedIn = isSignedIn();
      profile = getProfile();
      avatarBroken = false;
    });
    return off;
  });

  // Load GIS + (re)render Google's official button the first time the sidebar is
  // opened, and again after sign-out. `renderSignInButton` calls `initAuth`
  // internally (idempotent). No One Tap / auto_select — sign-in is button-only.
  $effect(() => {
    if (active && configured && !signedIn && buttonEl) {
      renderSignInButton(buttonEl, uiLang);
    }
  });
</script>

{#if configured}
  <div class="account" role="group" aria-label={t(uiLang, 'synapse.auth.account')}>
    {#if signedIn && profile}
      <div class="account__profile">
        {#if profile.picture && !avatarBroken}
          <img
            class="account__avatar"
            src={profile.picture}
            alt=""
            width="28"
            height="28"
            referrerpolicy="no-referrer"
            onerror={() => (avatarBroken = true)}
          />
        {:else}
          <span class="account__avatar account__avatar--fallback" aria-hidden="true">
            {(profile.name || profile.email || '?').charAt(0).toUpperCase()}
          </span>
        {/if}
        <span class="account__meta">
          <span class="account__name">{profile.name || profile.email}</span>
          {#if profile.email && profile.name}
            <span class="account__email">{profile.email}</span>
          {/if}
        </span>
        <button
          class="account__signout"
          onclick={signOut}
          title={t(uiLang, 'synapse.auth.signOut')}
        >
          {t(uiLang, 'synapse.auth.signOut')}
        </button>
      </div>
    {:else}
      <p class="account__note">{t(uiLang, 'synapse.auth.signInPrompt')}</p>
      <div bind:this={buttonEl} class="account__gbtn"></div>
      <p class="account__sub">{t(uiLang, 'synapse.auth.anonymousNote')}</p>
    {/if}
  </div>
{/if}

<style>
  .account {
    flex-shrink: 0;
    padding: 12px 14px 14px;
    border-top: 1px solid hsla(175, 80%, 50%, 0.07);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── Signed-out ─────────────────────────────────────────────────────────── */
  .account__note {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.66rem;
    line-height: 1.45;
    letter-spacing: 0.02em;
    color: hsla(175, 15%, 62%, 0.7);
  }

  .account__gbtn {
    display: flex;
    justify-content: center;
    min-height: 32px;
    /* GIS renders its own iframe/button; give it room without layout shift. */
    color-scheme: dark;
  }

  /* Google's own wrapper paints a light background behind the pill, which on
     this dark sidebar reads as a white card floating around the button. Its
     markup is obfuscated and versioned, so targeting those class names would
     be a fix with an expiry date. Clipping the host to the same pill radius
     hides the wrapper wherever it extends past the button, and keeps working
     whatever Google renders inside next. `width: fit-content` is what makes
     the clip hug the button rather than the full sidebar column. */
  .account__gbtn :global(> div) {
    border-radius: var(--radius-full, 999px);
    overflow: hidden;
    width: fit-content;
  }

  .account__sub {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.58rem;
    line-height: 1.4;
    letter-spacing: 0.02em;
    color: hsla(175, 10%, 48%, 0.5);
  }

  /* ── Signed-in ──────────────────────────────────────────────────────────── */
  .account__profile {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .account__avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid hsla(175, 80%, 50%, 0.25);
  }

  .account__avatar--fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    background: hsla(175, 40%, 12%, 0.7);
    color: #00ffd5;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    font-weight: 700;
    user-select: none;
  }

  .account__meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .account__name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: hsla(175, 20%, 72%, 0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.01em;
  }

  .account__email {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.58rem;
    color: hsla(175, 10%, 50%, 0.55);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .account__signout {
    flex-shrink: 0;
    padding: 5px 9px;
    background: transparent;
    border: 1px solid hsla(175, 80%, 50%, 0.15);
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: hsla(175, 20%, 60%, 0.6);
    cursor: pointer;
    transition:
      color 180ms ease,
      border-color 180ms ease,
      background 180ms ease;
  }

  .account__signout:hover {
    color: #00ffd5;
    border-color: hsla(175, 80%, 50%, 0.35);
    background: hsla(175, 40%, 10%, 0.4);
  }
</style>
