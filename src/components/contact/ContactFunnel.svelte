<script lang="ts">
  /**
   * ContactFunnel — the written-first intake. Four questions, validated
   * locally; the result is a prefilled email opened in the visitor's own
   * mail client. CSP forbids form posts (form-action 'none') and that is
   * the design, not a workaround: the funnel has NO backend, nothing is
   * stored or sent until the visitor presses Send in their own mailer —
   * which the success panel says out loud, because for this audience a
   * form that provably cannot leak is a selling point.
   *
   * Cal.com stays the second door (owner: async writing first — spoken
   * calls are the option, never the requirement).
   */
  import { tick, onDestroy } from 'svelte';
  import {
    BUDGET_OPTIONS,
    TIMELINE_OPTIONS,
    validate,
    isValid,
    isGateTripped,
    buildMailtoUrl,
    buildCalUrl,
    buildEmailText,
  } from '@/lib/contact-form';
  import type { ContactFormData, FieldErrors } from '@/lib/contact-form';
  import { CONTACT_EMAIL } from '@/lib/site-config';

  export interface FunnelLabels {
    company: string;
    companyHint: string;
    task: string;
    taskHint: string;
    budget: string;
    timeline: string;
    choose: string;
    submit: string;
    successHeading: string;
    successBody: string;
    openMail: string;
    orCal: string;
    editAnswers: string;
    replyPromise: string;
    errors: {
      required: string;
      'too-short': string;
      'too-long': string;
    };
  }

  let { lang, labels }: { lang: 'en' | 'ru'; labels: FunnelLabels } = $props();

  let data = $state<ContactFormData>({ company: '', task: '', budget: '', timeline: '' });
  let errors = $state<FieldErrors>({});
  let submitted = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  // Anti-bot (owner decision, worklist M4; gate-order fix P2): a honeypot
  // field no human sees. Validation always runs first (below) so a real
  // visitor's mistakes are shown normally; only a FILLED honeypot silently
  // "accepts" a submit — that only happens to a script. Worthless against
  // nothing today (mailto has no server to spam), but the future /api/lead
  // endpoint inherits this exact contract, elapsed-fill-time included (see
  // isGateTripped's doc comment for why that signal doesn't gate here).
  let honeypot = $state('');
  const mountedAt = Date.now();

  // Bound refs for focus management: the success heading gets keyboard/SR
  // focus on submit, the first invalid control gets it on a failed submit,
  // and "Edit the answers" returns focus to the first field.
  let companyEl = $state<HTMLInputElement | null>(null);
  let taskEl = $state<HTMLTextAreaElement | null>(null);
  let budgetEl = $state<HTMLSelectElement | null>(null);
  let timelineEl = $state<HTMLSelectElement | null>(null);
  let successHeadingEl = $state<HTMLHeadingElement | null>(null);

  // Strings that live only here, not in the page's copy object (see the
  // component's props/labels contract) — kept bilingual via the same
  // lang-keyed-object pattern already used for FIELD labels in contact-form.ts.
  const COPY_LABELS: Record<'en' | 'ru', { copy: string; copied: string }> = {
    en: { copy: 'Copy the full text', copied: 'Copied' },
    ru: { copy: 'Скопировать текст письма', copied: 'Скопировано' },
  };
  // The address in plain, selectable text. A mailto: link is the primary
  // action, but in a corporate webmail (Outlook Web, Gmail in a tab) an
  // unregistered mailto handler does NOTHING and reports nothing — the visitor
  // clicks, sees no mail client, and leaves. There is no analytics on this
  // site, so a lead lost that way is lost silently. Showing the address costs
  // one line and gives that visitor somewhere to go.
  const WRITE_DIRECT: Record<'en' | 'ru', string> = {
    en: 'Or write directly:',
    ru: 'Или напишите напрямую:',
  };
  const NEW_TAB_HINT: Record<'en' | 'ru', string> = {
    en: 'opens in a new tab',
    ru: 'открывается в новой вкладке',
  };
  const TASK_PLACEHOLDER: Record<'en' | 'ru', string> = {
    en: 'A few sentences are enough.',
    ru: 'Достаточно нескольких предложений.',
  };

  // The etalon CTA's magnetism (geo-audit's initGeoHeroManners, same
  // coefficient): the submit pill leans toward the cursor while hovered.
  // $effect only runs client-side, so the SSR pass never touches window.
  let submitEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const el = submitEl;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let hovering = false;
    const enter = (): void => {
      hovering = true;
      el.classList.add('is-magnetic');
    };
    const leave = (): void => {
      hovering = false;
      el.classList.remove('is-magnetic');
      el.style.transform = '';
    };
    const move = (e: MouseEvent): void => {
      if (!hovering) return;
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      el.style.transform = `translate(${cx * 0.25}px, ${cy * 0.25}px)`;
    };

    el.addEventListener('mouseenter', enter);
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mousemove', move);
      el.removeEventListener('mouseleave', leave);
    };
  });
  // (Verified: submitEl resets to null on unmount, which re-runs the effect
  // above through its early return and disposes the previous listeners via
  // its cleanup — no leak. Applying the same care to the timer below.)
  onDestroy(() => clearTimeout(copyTimer));

  const mailtoUrl = $derived(buildMailtoUrl(data, lang));
  const calUrl = $derived(buildCalUrl(data, lang));

  function errorText(code: 'required' | 'too-short' | 'too-long' | undefined): string {
    return code ? labels.errors[code] : '';
  }

  // Focuses the first invalid control in DOM order, matching how a
  // keyboard/SR user reads the form top to bottom.
  async function focusFirstError(): Promise<void> {
    await tick();
    if (errors.company) {
      companyEl?.focus();
    } else if (errors.task) {
      taskEl?.focus();
    } else if (errors.budget) {
      budgetEl?.focus();
    } else if (errors.timeline) {
      timelineEl?.focus();
    }
  }

  async function focusSuccessHeading(): Promise<void> {
    await tick();
    successHeadingEl?.focus();
  }

  async function onEditAnswers(): Promise<void> {
    submitted = false;
    await tick();
    companyEl?.focus();
  }

  async function onCopyFullText(): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(buildEmailText(data, lang));
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      // Clipboard permission denied or unavailable — the mailto link and
      // the Cal.com door both still work, so this fails silently.
    }
  }

  function onSubmit(e: SubmitEvent): void {
    e.preventDefault();

    // Validate first, always — a tripped honeypot must never suppress
    // errors a real visitor would want to see (gate-order fix, P2).
    errors = validate(data);
    if (!isValid(errors)) {
      void focusFirstError();
      return;
    }

    const elapsedMs = Date.now() - mountedAt;
    if (isGateTripped(honeypot, elapsedMs)) {
      // Silent accept: a script tripped the honeypot. The panel still
      // swaps to the success state so the bot learns nothing from it —
      // still moving focus too, in case a real visitor is ever
      // misclassified (an odd autofill extension, say).
      submitted = true;
      void focusSuccessHeading();
      return;
    }

    submitted = true;
    void focusSuccessHeading();
  }
</script>

{#if !submitted}
  <!-- method="dialog" is the pre-hydration guard: this island is client:visible,
       so a visitor who clicks Send in the moment between the form entering the
       viewport and the island booting would otherwise trigger a NATIVE submit —
       which navigates to ?website= and loses every answer (and, in production,
       is blocked outright by CSP form-action 'none'). Outside a <dialog>, a
       dialog-method submission is specified to do nothing at all. -->
  <form class="funnel glass-panel" method="dialog" onsubmit={onSubmit} novalidate>
    <!-- Honeypot: named for what autofill loves to fill and what a script
         loves to find, ignored by Chrome's address autofill because it
         isn't a recognized field name; removed from every human channel
         (sight, tab order, screen readers) but present to a script. -->
    <div class="funnel__hp" aria-hidden="true">
      <label for="funnel-website">Leave this field empty</label>
      <input
        id="funnel-website"
        name="website"
        type="text"
        tabindex="-1"
        aria-hidden="true"
        autocomplete="one-time-code"
        bind:value={honeypot}
      />
    </div>

    <div class="funnel__field">
      <label class="funnel__label text-mono" for="funnel-company">{labels.company}</label>
      <input
        id="funnel-company"
        class="funnel__input"
        type="text"
        bind:value={data.company}
        bind:this={companyEl}
        placeholder={labels.companyHint}
        maxlength="200"
        aria-required="true"
        aria-invalid={errors.company ? 'true' : undefined}
        aria-describedby={errors.company ? 'funnel-company-error' : undefined}
      />
      {#if errors.company}<p class="funnel__error" id="funnel-company-error">
          {errorText(errors.company)}
        </p>{/if}
    </div>

    <div class="funnel__field">
      <label class="funnel__label text-mono" for="funnel-task">{labels.task}</label>
      <p class="funnel__hint" id="funnel-task-hint">{labels.taskHint}</p>
      <textarea
        id="funnel-task"
        class="funnel__input funnel__textarea"
        bind:value={data.task}
        bind:this={taskEl}
        placeholder={TASK_PLACEHOLDER[lang]}
        rows="5"
        maxlength="2000"
        aria-required="true"
        aria-invalid={errors.task ? 'true' : undefined}
        aria-describedby={errors.task ? 'funnel-task-hint funnel-task-error' : 'funnel-task-hint'}
      ></textarea>
      {#if errors.task}
        <p class="funnel__error" id="funnel-task-error">{errorText(errors.task)}</p>
      {/if}
    </div>

    <div class="funnel__row">
      <div class="funnel__field">
        <label class="funnel__label text-mono" for="funnel-budget">{labels.budget}</label>
        <select
          id="funnel-budget"
          class="funnel__input funnel__select"
          bind:value={data.budget}
          bind:this={budgetEl}
          aria-required="true"
          aria-invalid={errors.budget ? 'true' : undefined}
          aria-describedby={errors.budget ? 'funnel-budget-error' : undefined}
        >
          <option value="" disabled>{labels.choose}</option>
          {#each BUDGET_OPTIONS as opt (opt.value)}
            <option value={opt.value}>{opt[lang]}</option>
          {/each}
        </select>
        {#if errors.budget}<p class="funnel__error" id="funnel-budget-error">
            {errorText(errors.budget)}
          </p>{/if}
      </div>

      <div class="funnel__field">
        <label class="funnel__label text-mono" for="funnel-timeline">{labels.timeline}</label>
        <select
          id="funnel-timeline"
          class="funnel__input funnel__select"
          bind:value={data.timeline}
          bind:this={timelineEl}
          aria-required="true"
          aria-invalid={errors.timeline ? 'true' : undefined}
          aria-describedby={errors.timeline ? 'funnel-timeline-error' : undefined}
        >
          <option value="" disabled>{labels.choose}</option>
          {#each TIMELINE_OPTIONS as opt (opt.value)}
            <option value={opt.value}>{opt[lang]}</option>
          {/each}
        </select>
        {#if errors.timeline}<p class="funnel__error" id="funnel-timeline-error">
            {errorText(errors.timeline)}
          </p>{/if}
      </div>
    </div>

    <button type="submit" class="funnel__submit" bind:this={submitEl}>{labels.submit}</button>
    <p class="funnel__promise text-mono">{labels.replyPromise}</p>
  </form>
{:else}
  <div class="funnel funnel--done glass-panel" role="status">
    <h2 class="funnel__done-heading" tabindex="-1" bind:this={successHeadingEl}>
      {labels.successHeading}
    </h2>
    <p class="funnel__done-body">{labels.successBody}</p>
    <a href={mailtoUrl} class="funnel__submit funnel__submit--link">{labels.openMail}</a>
    <button type="button" class="funnel__copy" onclick={() => void onCopyFullText()}>
      {copied ? COPY_LABELS[lang].copied : COPY_LABELS[lang].copy}
    </button>
    <p class="funnel__direct">
      {WRITE_DIRECT[lang]}
      <a href={`mailto:${CONTACT_EMAIL}`} class="funnel__address">{CONTACT_EMAIL}</a>
    </p>
    <p class="funnel__cal">
      <a href={calUrl} target="_blank" rel="noopener noreferrer">
        {labels.orCal}
        <span aria-hidden="true">→</span><span class="visually-hidden">— {NEW_TAB_HINT[lang]}</span>
      </a>
    </p>
    <button type="button" class="funnel__edit" onclick={() => void onEditAnswers()}>
      <span aria-hidden="true">←</span>
      {labels.editAnswers}
    </button>
  </div>
{/if}

<style>
  .funnel {
    position: relative;
    padding: var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* Honeypot: removed from every human channel (sight, tab order, screen
     readers) but perfectly present to a form-filling script. */
  .funnel__hp {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .funnel__field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
  }

  .funnel__row {
    display: flex;
    gap: var(--space-5);
  }

  /* 767, not 639: the site's structural mobile breakpoint is 767px (80 uses
     against 14), and it is the one the page's own JS `matchMedia` reads. Two
     side-by-side fields at 700px leave each about 21 characters of measure —
     narrower than either label needs. */
  @media (max-width: 767px) {
    .funnel__row {
      flex-direction: column;
    }
  }

  .funnel__label {
    font-size: var(--text-xs);
  }

  .funnel__input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-size: var(--text-base);
    color: var(--text-primary);
    background: hsla(220, 20%, 8%, 0.7);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    transition:
      border-color var(--duration-normal) var(--ease-out),
      box-shadow var(--duration-normal) var(--ease-out);
  }

  .funnel__input::placeholder {
    color: var(--text-ghost);
  }

  /* The near-invisible faint glow this used to show is gone — border color
     plus an opaque 2px ring, and no local `outline: none` to fight the
     global :focus-visible ring (global.css), which now shows through too. */
  .funnel__input:focus-visible {
    border-color: var(--accent-green-300);
    box-shadow: 0 0 0 2px var(--accent-green-400);
  }

  .funnel__input[aria-invalid='true'] {
    border-color: hsl(0, 65%, 55%);
  }

  .funnel__textarea {
    resize: vertical;
    min-height: 8rem;
    line-height: 1.6;
  }

  .funnel__hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .funnel__select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b7a8f' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right var(--space-4) center;
    padding-right: var(--space-10);
    cursor: pointer;
  }

  .funnel__error {
    margin: 0;
    font-size: var(--text-xs);
    color: hsl(0, 65%, 65%);
  }

  /* The homepage CTA pill recipe (HeroOverlay's .hero-overlay__cta family). */
  .funnel__submit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-8);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    text-decoration: none;
    color: var(--bg-void);
    background: linear-gradient(135deg, var(--accent-green-300), var(--accent-green-400));
    border: 1px solid var(--accent-green-200);
    border-radius: var(--radius-md);
    cursor: pointer;
    align-self: flex-start;
    transition:
      box-shadow 0.3s ease-out,
      border-color 0.3s ease-out,
      transform 0.3s ease-out;
  }

  /* Magnetic state: snappier follow while hovered (homepage coefficient). */
  .funnel__submit.is-magnetic {
    transition-duration: 0.08s;
  }

  .funnel__submit:hover {
    box-shadow:
      0 0 20px var(--accent-glow-strong),
      0 0 60px var(--accent-glow),
      inset 0 0 20px hsla(155, 70%, 70%, 0.15);
    border-color: var(--accent-green-100);
  }

  .funnel__promise {
    margin: 0;
    font-size: var(--text-xs);
    text-transform: none;
    letter-spacing: var(--tracking-normal);
    color: var(--text-muted);
  }

  .funnel--done {
    text-align: left;
  }

  .funnel__done-heading {
    font-size: var(--text-h3);
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
    margin: 0;
  }

  .funnel__done-body {
    color: var(--text-secondary);
    line-height: 1.7;
    margin: 0;
    max-width: 58ch;
  }

  .funnel__direct {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  /* The address is selectable text on purpose: someone whose mailto handler
     is missing needs to copy it by hand. break-all keeps it inside the panel
     on a 375px screen instead of widening the layout. */
  .funnel__address {
    color: var(--accent-green-300);
    font-family: var(--font-mono);
    text-decoration: none;
    overflow-wrap: break-word;
    transition: color var(--duration-normal) var(--ease-out);
  }

  .funnel__address:hover {
    color: var(--accent-green-200);
  }

  .funnel__cal {
    margin: 0;
  }

  .funnel__cal a {
    color: var(--accent-green-300);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .funnel__cal a:hover {
    color: var(--accent-green-200);
  }

  .funnel__copy {
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-ghost);
    cursor: pointer;
    transition: color var(--duration-normal) var(--ease-out);
  }

  .funnel__copy:hover {
    color: var(--accent-green-300);
  }

  .funnel__edit {
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-ghost);
    cursor: pointer;
    transition: color var(--duration-normal) var(--ease-out);
  }

  .funnel__edit:hover {
    color: var(--accent-green-300);
  }

  /* Touch targets: 44px minimum tap height wherever a finger can reach.
     Three gates, because each one alone leaves a real device out:
       - `any-pointer: coarse` catches touch no matter what the PRIMARY
         pointer is, so a phone with a mouse attached and a touchscreen
         laptop whose primary pointer is the trackpad both keep the floor.
         The narrower `(hover: none) and (pointer: coarse)` missed both.
       - `max-width: 767px` keeps the floor on a narrow window with a mouse,
         which the width gate used to cover and a pointer-only gate dropped.
     The original width-only gate read `max-width: 639px`, so an iPad in
     portrait — 768px and entirely touch — took the desktop treatment and
     shipped ~19px-tall "Copy" and "Edit answers" controls. A tablet is not a
     desktop because it is wide, and a small window is not a phone. */
  @media (any-pointer: coarse), (max-width: 767px) {
    .funnel__copy,
    .funnel__edit,
    .funnel__cal a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
    }
  }
</style>
