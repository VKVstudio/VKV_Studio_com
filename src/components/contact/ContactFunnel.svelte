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
   */
  import { tick, onDestroy, onMount } from 'svelte';
  import {
    BUDGET_OPTIONS,
    TIMELINE_OPTIONS,
    validate,
    isValid,
    isGateTripped,
    buildMailtoUrl,
    buildEmailText,
  } from '@/lib/contact-form';
  import type { ContactFormData, FieldErrors } from '@/lib/contact-form';
  import { CONTACT_EMAIL } from '@/lib/site-config';
  import { t } from '@/i18n/utils';
  import {
    readContactContext,
    contactBriefingHref,
    type ContactContext,
  } from '@/lib/contact-context';
  import { resolveLocalProPreview } from '@/lib/pro-promo';

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
    editAnswers: string;
    replyPromise: string;
    errors: {
      required: string;
      'too-short': string;
      'too-long': string;
    };
  }

  let {
    lang,
    labels,
    localPreviewUrl = null,
  }: { lang: 'en' | 'ru'; labels: FunnelLabels; localPreviewUrl?: string | null } = $props();

  let data = $state<ContactFormData>({ company: '', task: '', budget: '', timeline: '' });
  let errors = $state<FieldErrors>({});
  let submitted = $state(false);
  let copied = $state(false);
  let copyFailed = $state(false);
  let context = $state<ContactContext>({});
  let ready = $state(false);
  onMount(() => {
    context = readContactContext(window.location.search);
    ready = true;
  });
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

  // The address in plain, selectable text. A mailto: link is the primary
  // action, but in a corporate webmail (Outlook Web, Gmail in a tab) an
  // unregistered mailto handler does NOTHING and reports nothing — the visitor
  // clicks, sees no mail client, and leaves. There is no analytics on this
  // site, so a lead lost that way is lost silently. Showing the address costs
  // one line and gives that visitor somewhere to go.

  const TASK_PLACEHOLDER: Record<'en' | 'ru', string> = {
    en: 'A few sentences are enough.',
    ru: 'Достаточно нескольких предложений.',
  };

  // WebMCP declarative descriptions — what a visiting AI agent reads to
  // understand this form. Chrome's budgets are hard: the tool name is capped
  // at 30 characters, the description at 500, each parameter description at
  // 150. tests/unit/webmcp-contact-form.test.ts measures all three against the
  // strings below — against THIS SOURCE, not against rendered HTML, which is
  // worth knowing before trusting it: the attributes reach an agent only
  // because Astro server-renders this island, so that test also pins the
  // contact page's client:visible directive.
  //
  // Deliberately NOT set: `toolautosubmit`. It makes the agent's submission a
  // real navigation, which this site's CSP forbids outright (form-action
  // 'none') — the agent would get no answer and the visitor would lose their
  // answers. Without it the submission stays a dialog-method submit, which
  // never reaches the CSP check at all. The honeypot below has no description
  // on purpose: an agent is given no reason to fill a field whose only job is
  // to catch scripts that fill everything.
  // The field order an agent is told about when its submission fails
  // validation, and the sentence that introduces the list.
  const FIELD_ORDER = ['company', 'task', 'budget', 'timeline'] as const;
  const AGENT_ERRORS: Record<'en' | 'ru', { intro: string }> = {
    en: { intro: 'The enquiry was not accepted. Fix these answers and submit again:' },
    ru: { intro: 'Обращение не принято. Исправьте эти ответы и отправьте снова:' },
  };

  const AGENT: Record<
    'en' | 'ru',
    { tool: string; company: string; task: string; budget: string; timeline: string }
  > = {
    en: {
      tool: 'Prepare an enquiry to VKVstudio about a web or AI engineering project. Nothing is sent anywhere: the answers are composed into an email that the person reviews and sends from their own mail client, and the studio replies in writing within one business day.',
      company: 'The company and what it does — one line is enough.',
      task: 'The task in the person’s own words. A few sentences; what outcome they want, not a specification.',
      budget: 'Budget band for the work. Must be one of the options offered by the field.',
      timeline: 'How soon the work should start. Must be one of the options offered by the field.',
    },
    ru: {
      tool: 'Подготовить обращение в VKVstudio о проекте по веб- или AI-разработке. Никуда ничего не отправляется: ответы складываются в письмо, которое человек проверяет и отправляет из своего почтового клиента, а студия отвечает письменно в течение одного рабочего дня.',
      company: 'Компания и чем занимается — достаточно одной строки.',
      task: 'Задача своими словами. Несколько предложений: какой нужен результат, а не техническое задание.',
      budget: 'Бюджетная вилка. Должно быть одним из вариантов, предлагаемых полем.',
      timeline: 'Когда начинать работу. Должно быть одним из вариантов, предлагаемых полем.',
    },
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

  const mailtoUrl = $derived(buildMailtoUrl(data, lang, context));
  const emailText = $derived(buildEmailText(data, lang, context));
  const briefingHref = $derived.by(() => {
    const canonical = contactBriefingHref(context);
    const local = resolveLocalProPreview(localPreviewUrl ?? undefined);
    return canonical && local ? canonical.replace('https://vkvstudio.pro/', local) : null;
  });

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
    copyFailed = false;
    if (!navigator.clipboard) {
      copyFailed = true;
      return;
    }
    try {
      await navigator.clipboard.writeText(emailText);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      copyFailed = true;
    }
  }

  function onSubmit(e: SubmitEvent): void {
    e.preventDefault();

    // WebMCP: the same event, seen from the agent side. `agentInvoked` is
    // undefined for every human, so nothing below changes the human flow.
    const agentEvent = e as SubmitEvent & {
      agentInvoked?: boolean;
      respondWith?: (value: unknown) => void;
    };
    const byAgent = agentEvent.agentInvoked === true;
    const answerAgent = (text: string): void => {
      if (typeof agentEvent.respondWith === 'function') {
        agentEvent.respondWith(Promise.resolve({ content: [{ type: 'text', text }] }));
      }
    };

    // Validate first, always — a tripped honeypot must never suppress
    // errors a real visitor would want to see (gate-order fix, P2).
    errors = validate(data);
    if (!isValid(errors)) {
      void focusFirstError();
      // ...and an agent must never be left hanging here. Found by audit
      // 2026-09-20: Chrome publishes this form's schema with `required: []`
      // (see the `required` attributes added to the controls, which fix the
      // contract itself), so a compliant agent that omitted a field landed on
      // this bare `return` and got Chromium's "the site has a programming
      // error" instead of an answer it could act on. The ordering test stayed
      // green throughout, because it asserted the order of the guards and not
      // that this one answers.
      if (byAgent) {
        answerAgent(
          `${AGENT_ERRORS[lang].intro}\n${FIELD_ORDER.filter((f) => errors[f])
            .map((f) => `- ${f}: ${errorText(errors[f])}`)
            .join('\n')}`
        );
      }
      return;
    }

    // WebMCP: an agent filled and submitted this form on a person's behalf.
    // Two things change, and only for that path — `agentInvoked` is undefined
    // for every human, so the branch below is unreachable in an ordinary
    // browser and the human flow is byte-for-byte what it was.
    //
    // 1. The honeypot gate is skipped. An agent that fills every field it can
    //    see is doing its job, not attacking us; punishing it with the silent
    //    accept would swallow a real lead without a trace.
    // 2. We answer with the composed email text instead of only swapping the
    //    panel, so the agent has something to hand back to the person — this
    //    form has no backend and never sends anything by itself.
    if (byAgent) {
      submitted = true;
      void focusSuccessHeading();
      answerAgent(buildEmailText(data, lang, context));
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

{#if context.service || briefingHref}
  <aside class="funnel__context glass-panel">
    {#if context.service}<p>
        {t(lang, 'contact.contextService')}:
        <strong>{t(lang, `contact.contextServices.${context.service}`)}</strong>
      </p>{/if}
    {#if briefingHref}<p><a href={briefingHref}>{t(lang, 'contact.contextBriefing')}</a></p>{/if}
    <p class="funnel__hint">{t(lang, 'contact.contextNote')}</p>
  </aside>
{/if}

{#if !submitted}
  <!-- method="dialog" is the pre-hydration guard: this island is client:visible,
       so a visitor who clicks Send in the moment between the form entering the
       viewport and the island booting would otherwise trigger a NATIVE submit —
       which navigates to ?website= and loses every answer (and, in production,
       is blocked outright by CSP form-action 'none'). Outside a <dialog>, a
       dialog-method submission is specified to do nothing at all. -->
  <form
    class="funnel glass-panel"
    method="dialog"
    aria-busy={!ready}
    onsubmit={onSubmit}
    novalidate
    toolname="submit_project_brief"
    tooldescription={AGENT[lang].tool}
  >
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
        toolparamdescription="Do not fill this field. It exists to catch automated scripts."
        autocomplete="one-time-code"
        bind:value={honeypot}
      />
    </div>

    <div class="funnel__field">
      <label class="funnel__label text-mono" for="funnel-company">{labels.company}</label>
      <input
        id="funnel-company"
        name="company"
        disabled={!ready}
        required
        toolparamdescription={AGENT[lang].company}
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
        name="task"
        disabled={!ready}
        required
        toolparamdescription={AGENT[lang].task}
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
          name="budget"
          disabled={!ready}
          required
          toolparamdescription={AGENT[lang].budget}
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
          name="timeline"
          disabled={!ready}
          required
          toolparamdescription={AGENT[lang].timeline}
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

    <button type="submit" disabled={!ready} class="funnel__submit" bind:this={submitEl}
      >{labels.submit}</button
    >
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
      {t(lang, copied ? 'contact.copied' : 'contact.copyText')}
    </button>
    {#if copyFailed}<p class="funnel__error" role="alert">{t(lang, 'contact.copyFailed')}</p>{/if}
    <details class="funnel__draft">
      <summary>{t(lang, 'contact.draftText')}</summary>
      <pre>{emailText}</pre>
    </details>
    <p class="funnel__direct">
      {t(lang, 'contact.directLabel')}
      <a href={`mailto:${CONTACT_EMAIL}`} class="funnel__address">{CONTACT_EMAIL}</a>
    </p>

    <button type="button" class="funnel__edit" onclick={() => void onEditAnswers()}>
      <span aria-hidden="true">←</span>
      {labels.editAnswers}
    </button>
  </div>
{/if}

<style>
  .funnel__context {
    padding: var(--space-5);
    margin-bottom: var(--space-5);
    color: var(--text-secondary);
  }
  .funnel__context p {
    margin-bottom: var(--space-2);
    overflow-wrap: anywhere;
  }
  .funnel__context a {
    color: var(--accent-green-300);
    text-decoration: underline;
  }
  .funnel__draft summary {
    cursor: pointer;
    min-height: 44px;
    color: var(--text-secondary);
  }
  .funnel__draft pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
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
    .funnel__edit {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
    }
  }
</style>
