<script lang="ts">
  import { t } from '../../../i18n/utils';
  import { MODELS } from '../../../lib/prompt/builder';
  import { SYNAPSE_API_BASE } from '@/lib/api-config';

  let { lang = 'en', onGenerated } = $props<{
    lang?: 'en' | 'ru';
    onGenerated: (blocks: { role: string; content: string }[]) => void;
  }>();

  let userInput = $state('');
  let selectedModel = $state(MODELS[0].id);
  let selectedStyle = $state('structured');
  let isGenerating = $state(false);
  /**
   * The one user-facing surface on this site that had no failure path at all:
   * a throw, a bare console.error, and a button that went back to enabled with
   * nothing said. On a backend that takes ~40 s and rate-limits per IP, that
   * meant a visitor could press it, wait, and be told nothing — twice, then
   * conclude the tool was broken. Everything else here degrades visibly; this
   * did not.
   */
  let genError = $state<string | null>(null);

  /**
   * Deliberately NOT routed through createSynapseClient. That client answers a
   * dead backend with mock persona text, which contains no [SYSTEM]/[USER] tags,
   * so the parser below would drop "This is a scripted reply…" into the builder
   * as a user block. A silent failure is bad; a fabricated prompt presented as
   * generated output is worse.
   */
  const GENERATE_TIMEOUT_MS = 120_000;

  /**
   * Builds the generation request text in the current UI locale.
   *
   * This isn't just cosmetic: the backend (`inference/llm.py`) has no
   * explicit language parameter — it infers reply language from the
   * Cyrillic-character ratio of the *request text itself*. A Russian-only
   * scaffold (as this used to be, hardcoded) made every request look
   * Russian to that heuristic regardless of the site locale, so `/en/`
   * always got a Russian reply. Keeping the scaffold's majority script
   * aligned with `lang`, plus an explicit "respond only in X" directive,
   * fixes that at the source. The `[SYSTEM]`/`[USER]`/`[ASSISTANT]` tags
   * are deliberately kept as literal, untranslated ASCII in both locales —
   * the parsing below matches on those exact tags regardless of language.
   */
  function buildGenerationPrompt(
    uiLang: 'en' | 'ru',
    task: string,
    model: string,
    style: string
  ): string {
    if (uiLang === 'ru') {
      return `Ты генератор промптов. Сгенерируй промпт для следующей задачи.
Отвечай ТОЛЬКО на русском языке — не используй английский или другой язык.
Задача: ${task}
Целевая модель: ${model}
Стиль: ${style}
Ответ дай в формате (метки [SYSTEM]/[USER]/[ASSISTANT] оставь как есть, латиницей):
[SYSTEM]
текст системного промпта
[USER]
текст пользовательского сообщения
Не добавляй пояснений. Только промпт.`;
    }
    return `You are a prompt generator. Generate a prompt for the following task.
Respond ONLY in English — do not use Russian or any other language.
Task: ${task}
Target model: ${model}
Style: ${style}
Format your answer exactly like this (keep the [SYSTEM]/[USER]/[ASSISTANT] tags in English as-is):
[SYSTEM]
system prompt text
[USER]
user message text
Do not add explanations. Output only the prompt.`;
  }

  async function handleGenerate() {
    if (!userInput.trim() || isGenerating) return;

    isGenerating = true;
    genError = null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), GENERATE_TIMEOUT_MS);
    try {
      const promptText = buildGenerationPrompt(lang, userInput, selectedModel, selectedStyle);

      const res = await fetch(`${SYNAPSE_API_BASE}/api/chat`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        // `lang` is passed alongside the directive baked into `promptText`
        // above so a future backend revision can key off it directly —
        // the current `/api/chat` (ChatRequest, extra="ignore") simply
        // drops unknown fields, so this is inert until then, not a break.
        body: JSON.stringify({ message: promptText, history: [], lang }),
      });

      if (!res.ok) {
        // 429 is the common one and is not a fault: the backend rate-limits per
        // IP, and a shared address reaches it without anyone misbehaving.
        genError = t(lang, res.status === 429 ? 'prompt.generateBusy' : 'prompt.generateError');
        return;
      }

      const data = await res.json();
      const text = data.response;

      // Parse blocks
      const blocks: { role: string; content: string }[] = [];

      const systemMatch = text.match(/\[SYSTEM\]\n?([\s\S]*?)(?=\[USER\]|\[ASSISTANT\]|$)/i);
      const userMatch = text.match(/\[USER\]\n?([\s\S]*?)(?=\[SYSTEM\]|\[ASSISTANT\]|$)/i);
      const assistantMatch = text.match(/\[ASSISTANT\]\n?([\s\S]*?)(?=\[SYSTEM\]|\[USER\]|$)/i);

      if (systemMatch && systemMatch[1].trim()) {
        blocks.push({ role: 'system', content: systemMatch[1].trim() });
      }
      if (userMatch && userMatch[1].trim()) {
        blocks.push({ role: 'user', content: userMatch[1].trim() });
      }
      if (assistantMatch && assistantMatch[1].trim()) {
        blocks.push({ role: 'assistant', content: assistantMatch[1].trim() });
      }

      if (blocks.length > 0) {
        onGenerated(blocks);
      } else {
        // Fallback if no tags found
        onGenerated([{ role: 'user', content: text.trim() }]);
      }
    } catch (err) {
      genError = t(
        lang,
        (err as Error)?.name === 'AbortError' ? 'prompt.generateTimeout' : 'prompt.generateError'
      );
    } finally {
      clearTimeout(timer);
      isGenerating = false;
    }
  }
</script>

<div class="generator-card glass-panel">
  <div class="generator-heading">
    <h2 class="generator-title">{t(lang, 'prompt.generateTitle')}</h2>
    <p class="generator-hint">{t(lang, 'prompt.generateTabHint')}</p>
    <p class="generator-disclaimer" role="note">{t(lang, 'prompt.generateDisclaimer')}</p>
    {#if genError}
      <p class="generator-error" role="alert">{genError}</p>
    {/if}
  </div>

  <div class="generator-field">
    <textarea
      class="generator-textarea"
      bind:value={userInput}
      placeholder={t(lang, 'prompt.generatePlaceholder')}
      aria-label={t(lang, 'prompt.generateTitle')}
    ></textarea>
  </div>

  <div class="generator-controls">
    <div class="generator-select-group">
      <label for="model-select" class="generator-label">{t(lang, 'prompt.targetModel')}</label>
      <select id="model-select" bind:value={selectedModel} class="generator-select">
        {#each MODELS as model}
          <option value={model.id}>{model.name}</option>
        {/each}
      </select>
    </div>

    <div class="generator-select-group">
      <label for="style-select" class="generator-label">{t(lang, 'prompt.promptStyle')}</label>
      <select id="style-select" bind:value={selectedStyle} class="generator-select">
        <option value="structured">{t(lang, 'prompt.styleStructured')}</option>
        <option value="markdown">{t(lang, 'prompt.styleMarkdown')}</option>
        <option value="cot">{t(lang, 'prompt.styleCot')}</option>
        <option value="minimal">{t(lang, 'prompt.styleMinimal')}</option>
      </select>
    </div>
  </div>

  <button
    class="generator-btn"
    class:generating={isGenerating}
    disabled={!userInput.trim() || isGenerating}
    onclick={handleGenerate}
  >
    {#if isGenerating}
      <span class="pulse-dot"></span> {t(lang, 'prompt.generating')}
    {:else}
      {t(lang, 'prompt.generateButton')}
    {/if}
  </button>
  <p class="generator-slow-hint">{t(lang, 'prompt.generateSlowHint')}</p>
</div>

<style>
  .generator-card {
    background: var(--glass-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    backdrop-filter: blur(20px);
  }

  /* Standard property restated where a CSS minifier cannot fold it into
     the -webkit- alias — without this Firefox renders it flat. */
  @supports (backdrop-filter: blur(1px)) {
    .generator-card {
      backdrop-filter: blur(20px);
    }
  }

  .generator-heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .generator-title {
    font-size: var(--text-h3);
    color: var(--text-primary);
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .generator-hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin: 0;
    line-height: var(--leading-normal);
  }

  /* Honesty disclaimer — drafted by a model still in training (warning-amber convention) */
  .generator-disclaimer {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid hsla(40, 90%, 55%, 0.3);
    border-radius: var(--radius-md);
    background: hsla(40, 90%, 55%, 0.08);
    color: hsl(40, 90%, 68%);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
  }

  /* Same shape as the disclaimer above it, in the error hue rather than amber —
     it sits in the same place, so a visitor who has read one recognises the
     other as the tool speaking rather than as decoration. */
  .generator-error {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid hsla(0, 75%, 60%, 0.35);
    border-radius: var(--radius-md);
    background: hsla(0, 75%, 60%, 0.08);
    color: hsl(0, 80%, 76%);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
  }

  .generator-slow-hint {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: center;
  }

  .generator-field {
    display: flex;
    flex-direction: column;
  }

  .generator-textarea {
    width: 100%;
    min-height: 120px;
    background: var(--bg-void);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    resize: vertical;
    outline: none;
    transition: var(--transition-colors);
  }

  .generator-textarea:focus {
    /* was --accent-cyan-400, a token that is defined nowhere — the focus border
       silently kept its unfocused colour. Green is this tool's accent. */
    border-color: var(--accent-green-300);
  }

  .generator-textarea:focus-visible {
    outline: 2px solid var(--accent-green-400);
    outline-offset: 2px;
  }

  .generator-controls {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4);
  }

  @media (min-width: 640px) {
    .generator-controls {
      grid-template-columns: 1fr 1fr;
    }
  }

  .generator-select-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .generator-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .generator-select {
    width: 100%;
    background: var(--bg-void);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    outline: none;
    cursor: pointer;
  }

  .generator-select:focus {
    /* was --accent-cyan-400, a token that is defined nowhere — the focus border
       silently kept its unfocused colour. Green is this tool's accent. */
    border-color: var(--accent-green-300);
  }

  .generator-select:focus-visible {
    outline: 2px solid var(--accent-green-400);
    outline-offset: 2px;
  }

  @media (max-width: 767px) {
    /* Prevent iOS Safari auto-zoom on focus (requires >=16px font-size) */
    .generator-select {
      font-size: 16px;
    }
  }

  .generator-btn {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    background: var(--accent-green-400);
    color: var(--bg-obsidian);
    border: none;
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-8);
    font-family: var(--font-mono);
    font-weight: var(--weight-semibold);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: var(--transition-all);
  }

  .generator-btn:hover:not(:disabled) {
    box-shadow: 0 0 16px hsla(155, 70%, 50%, 0.4);
    transform: translateY(-1px);
  }

  .generator-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .generator-btn.generating {
    animation: pulse 1.5s infinite;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    background: var(--bg-obsidian);
    border-radius: 50%;
    animation: blink 1s infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .generator-btn.generating,
    .pulse-dot {
      animation: none;
    }
  }

  @keyframes pulse {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.8;
    }
    100% {
      opacity: 1;
    }
  }

  @keyframes blink {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
    100% {
      opacity: 1;
    }
  }
</style>
