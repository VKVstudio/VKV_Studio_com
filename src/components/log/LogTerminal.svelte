<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    lang: 'en' | 'ru';
    bootLines: string[];
  }

  const { lang, bootLines }: Props = $props();

  // Completed boot lines + the line currently being typed.
  let lines = $state<string[]>([]);
  let current = $state('');
  let done = $state(false);

  let reducedMotion = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const bootLabel = lang === 'ru' ? 'Последовательность загрузки' : 'Boot sequence';

  function typeSequence(): void {
    let lineIdx = 0;
    let charIdx = 0;

    function step(): void {
      if (cancelled) return;
      const line = bootLines[lineIdx];
      if (line === undefined) {
        done = true;
        return;
      }
      if (charIdx <= line.length) {
        // WRITE only — never read `current` here (Svelte 5: no read+write of one state).
        current = line.slice(0, charIdx);
        charIdx += 1;
        timer = setTimeout(step, 18 + Math.random() * 26);
        return;
      }
      // Line finished: commit it, reset, small pause before the next line.
      lines = [...lines, line];
      current = '';
      lineIdx += 1;
      charIdx = 0;
      timer = setTimeout(step, 240);
    }

    step();
  }

  onMount(() => {
    reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      lines = [...bootLines];
      done = true;
      return;
    }
    typeSequence();
  });

  onDestroy(() => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  });
</script>

<div class="boot" role="log" aria-label={bootLabel}>
  {#each lines as line, i (i)}
    <!-- Keyed by index, not by text: `lines` is append-only, and two identical
         boot lines would make a text key a duplicate-key crash. -->
    <div class="boot__line">{line}</div>
  {/each}
  {#if !done}
    <!-- aria-hidden, and it matters: role="log" is an implicit
         aria-live="polite" region, `current` grows by ONE CHARACTER every
         ~30ms, and without this a screen reader queues an announcement per
         keystroke — the whole boot sequence read out letter by letter. Hidden
         here, the region announces each line once, when it is committed to
         `lines` whole. That is what a log is supposed to sound like. -->
    <div class="boot__line boot__line--active" aria-hidden="true">
      {current}<span class="boot__cursor">▋</span>
    </div>
  {:else}
    <div class="boot__line boot__line--prompt">
      <span class="boot__caret" aria-hidden="true">$</span>
      <span class="boot__cursor boot__cursor--steady" aria-hidden="true">▋</span>
    </div>
  {/if}
</div>

<style>
  .boot {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--accent-green-300);
    min-height: calc(var(--text-sm) * var(--leading-normal) * 5);
  }

  .boot__line {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .boot__line--active {
    color: var(--accent-green-200);
  }

  .boot__line--prompt {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent-blue-200);
  }

  .boot__caret {
    color: var(--accent-green-300);
  }

  .boot__cursor {
    display: inline-block;
    color: var(--accent-green-200);
  }

  @media (prefers-reduced-motion: no-preference) {
    .boot__cursor {
      animation: boot-blink 0.7s step-end infinite;
    }
  }

  @keyframes boot-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }
</style>
