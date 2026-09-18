<script lang="ts">
  import type { Token } from '../../../lib/tokenizer/engine';
  import { placeTooltip, pointerXY } from '../../../lib/tokenizer/tooltip-position';
  import { t } from '../../../i18n/utils';

  let { tokens, lang = 'en' }: { tokens: Token[]; lang?: 'en' | 'ru' } = $props();

  // Tooltip state
  let tooltip = $state<{
    visible: boolean;
    x: number;
    y: number;
    token: Token | null;
  }>({ visible: false, x: 0, y: 0, token: null });

  /** Map token byte-length to a heatmap color: short = dark teal, long = bright cyan */
  function heatColor(text: string): string {
    const len = Math.min(text.length, 12); // clamp at 12 chars
    // 0..12 → lightness 18%..65%
    const lightness = 18 + (len / 12) * 47;
    // 0..12 → saturation 30%..85%
    const sat = 30 + (len / 12) * 55;
    return `hsl(185, ${sat.toFixed(0)}%, ${lightness.toFixed(0)}%)`;
  }

  /** Text color: light text on dark backgrounds, dark on bright */
  function textColor(text: string): string {
    const len = Math.min(text.length, 12);
    const lightness = 18 + (len / 12) * 47;
    return lightness > 42 ? 'hsl(220, 20%, 6%)' : 'hsl(210, 20%, 90%)';
  }

  function showTooltip(e: MouseEvent | TouchEvent | KeyboardEvent, token: Token) {
    const pointer = pointerXY(e);
    const { x, y } = placeTooltip(pointer.x, pointer.y);
    tooltip = { visible: true, x, y, token };
  }

  function hideTooltip() {
    tooltip = { ...tooltip, visible: false };
  }
</script>

<!-- Dismiss tooltip on viewport tap -->
<svelte:window onclick={hideTooltip} />

<div class="heatmap" aria-label={t(lang, 'tokenizer.heatmapLabel')}>
  {#each tokens as token, i (token.id + '-' + i)}
    <!-- svelte-ignore a11y_mouse_events_have_key_events -->
    <span
      class="heatmap__token"
      style="
        --heat-bg: {heatColor(token.text)};
        --heat-text: {textColor(token.text)};
        animation-delay: {Math.min(i, 60) * 20}ms;
      "
      role="button"
      tabindex="0"
      aria-label={t(lang, 'tokenizer.tokenAriaLabel')
        .replace('{id}', String(token.id))
        .replace('{text}', token.text)}
      onmousemove={(e) => showTooltip(e, token)}
      onmouseleave={hideTooltip}
      onclick={(e) => {
        e.stopPropagation();
        showTooltip(e, token);
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          showTooltip(e, token);
        }
      }}>{token.text}</span
    >
  {/each}
</div>

{#if tooltip.visible && tooltip.token}
  <div class="heatmap__tooltip" style="left: {tooltip.x}px; top: {tooltip.y}px;" role="tooltip">
    <div class="heatmap__tooltip-row">
      <span class="heatmap__tooltip-key">id</span>
      <span class="heatmap__tooltip-val">{tooltip.token.id}</span>
    </div>
    <div class="heatmap__tooltip-row">
      <span class="heatmap__tooltip-key">text</span>
      <span class="heatmap__tooltip-val heatmap__tooltip-text"
        >"{tooltip.token.text.replace(/\n/g, '↵').replace(/ /g, '·')}"</span
      >
    </div>
    {#if tooltip.token.partial}
      <div class="heatmap__tooltip-row">
        <span class="heatmap__tooltip-key">bytes</span>
        <span
          class="heatmap__tooltip-val heatmap__tooltip-val--partial"
          title={t(lang, 'tokenizer.partialByteSequenceTooltip')}
        >
          ⚠ {t(lang, 'tokenizer.partialByteSequence')}
        </span>
      </div>
    {:else}
      <div class="heatmap__tooltip-row">
        <span class="heatmap__tooltip-key">bytes</span>
        <span class="heatmap__tooltip-val">[{tooltip.token.bytes.join(', ')}]</span>
      </div>
      <div class="heatmap__tooltip-row">
        <span class="heatmap__tooltip-key">len</span>
        <span class="heatmap__tooltip-val">{tooltip.token.bytes.length}B</span>
      </div>
    {/if}
  </div>
{/if}

