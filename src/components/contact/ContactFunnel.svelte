<script lang="ts">
  import { tick, onDestroy, onMount } from 'svelte';
  import {
    BUDGET_OPTIONS,
    TIMELINE_OPTIONS,
    buildMailtoUrl,
    buildEmailText,
  } from '@/lib/contact-form';
  import type { ContactFormData } from '@/lib/contact-form';
  import {
    validateSubmission,
    submitContactEnquiry,
    createContactSiteKeyLoader,
    mountContactChallenge,
    type ContactSubmissionErrors,
    type ContactDeliveryCode,
    type ContactChallenge,
  } from '@/lib/contact-submission';
  import { CONTACT_EMAIL } from '@/lib/site-config';
  import { contactText as t } from '@/lib/contact-labels';
  import type { ContactLabels } from '@/lib/contact-labels';
  import {
    readContactContext,
    contactBriefingHref,
    type ContactContext,
  } from '@/lib/contact-context';
  import { resolveLocalProPreview } from '@/lib/pro-promo';

  export type FunnelLabels = ContactLabels;
  let {
    lang,
    labels,
    localPreviewUrl = null,
  }: {
    lang: 'en' | 'ru';
    labels: FunnelLabels;
    localPreviewUrl?: string | null;
  } = $props();

  let data = $state<ContactFormData>({ company: '', task: '', budget: '', timeline: '' });
  let replyEmail = $state('');
  let errors = $state<ContactSubmissionErrors>({});
  let submitted = $state(false);
  let deliveryStatus = $state<'delivered' | 'queued'>('delivered');
  let deliveryCode = $state<ContactDeliveryCode | null>(null);
  let sending = $state(false);
  let agentReview = $state(false);
  let copied = $state(false);
  let copyFailed = $state(false);
  let context = $state<ContactContext>({});
  let ready = $state(false);
  let honeypot = $state('');
  let turnstileToken = $state('');
  let challengeContainer = $state<HTMLDivElement | null>(null);
  let loadingChallenge = false;
  let siteKey: string | null = null;
  const getSiteKey = createContactSiteKeyLoader();
  let challenge: ContactChallenge | null = null;
  let destroyed = false;
  let requestId = '';
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  let replyEmailEl = $state<HTMLInputElement | null>(null);
  let companyEl = $state<HTMLInputElement | null>(null);
  let taskEl = $state<HTMLTextAreaElement | null>(null);
  let budgetEl = $state<HTMLSelectElement | null>(null);
  let timelineEl = $state<HTMLSelectElement | null>(null);
  let successHeadingEl = $state<HTMLHeadingElement | null>(null);
  let submitEl = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    context = readContactContext(window.location.search);
    requestId = crypto.randomUUID();
    ready = true;
    void getSiteKey().then((key) => {
      if (!destroyed) siteKey = key;
    });
  });
  onDestroy(() => {
    destroyed = true;
    clearTimeout(copyTimer);
    challenge?.destroy();
  });

  const FIELD_ORDER = ['replyEmail', 'company', 'task', 'budget', 'timeline'] as const;
  const AGENT = {
    en: {
      tool: t('en', 'contact.agent.tool'),
      replyEmail: t('en', 'contact.agent.replyEmail'),
      company: t('en', 'contact.agent.company'),
      task: t('en', 'contact.agent.task'),
      budget: t('en', 'contact.agent.budget'),
      timeline: t('en', 'contact.agent.timeline'),
    },
    ru: {
      tool: t('ru', 'contact.agent.tool'),
      replyEmail: t('ru', 'contact.agent.replyEmail'),
      company: t('ru', 'contact.agent.company'),
      task: t('ru', 'contact.agent.task'),
      budget: t('ru', 'contact.agent.budget'),
      timeline: t('ru', 'contact.agent.timeline'),
    },
  };

  // Scope this existing magnetic behavior to the submit button and clean up
  // on unmount. No effect reads and writes the same reactive state.
  $effect(() => {
    const el = submitEl;
    if (
      !el ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches
    )
      return;
    const leave = (): void => {
      el.style.transform = '';
    };
    const move = (event: MouseEvent): void => {
      if (el.disabled) return;
      const rect = el.getBoundingClientRect();
      el.style.transform =
        'translate(' +
        (event.clientX - rect.left - rect.width / 2) * 0.25 +
        'px, ' +
        (event.clientY - rect.top - rect.height / 2) * 0.25 +
        'px)';
    };
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mousemove', move);
      el.removeEventListener('mouseleave', leave);
      leave();
    };
  });

  const mailtoUrl = $derived(buildMailtoUrl(data, lang, context));
  const emailText = $derived(buildEmailText(data, lang, context));
  const briefingHref = $derived.by(() => {
    const canonical = contactBriefingHref(context);
    const local = resolveLocalProPreview(localPreviewUrl ?? undefined);
    return canonical && local ? canonical.replace('https://vkvstudio.pro/', local) : canonical;
  });

  function errorText(
    code: 'required' | 'too-short' | 'too-long' | 'invalid-email' | undefined
  ): string {
    return code ? labels.errors[code] : '';
  }

  async function focusFirstError(): Promise<void> {
    await tick();
    if (errors.replyEmail) replyEmailEl?.focus();
    else if (errors.company) companyEl?.focus();
    else if (errors.task) taskEl?.focus();
    else if (errors.budget) budgetEl?.focus();
    else if (errors.timeline) timelineEl?.focus();
  }

  async function beginVerification(): Promise<void> {
    if (!ready || loadingChallenge || challenge || submitted || destroyed) return;
    loadingChallenge = true;
    try {
      siteKey ??= await getSiteKey();
      if (!siteKey || destroyed) return;
      await tick();
      const container = challengeContainer;
      if (!container || destroyed) return;
      const mounted = await mountContactChallenge(
        container,
        siteKey,
        lang,
        (token) => {
          if (!destroyed) turnstileToken = token;
        },
        () => {
          if (!destroyed) deliveryCode = 'verification';
        }
      );
      if (destroyed || !container.isConnected) mounted.destroy();
      else challenge = mounted;
    } catch {
      if (!destroyed) deliveryCode = 'verification';
    } finally {
      loadingChallenge = false;
    }
  }

  async function onEditAnswers(): Promise<void> {
    submitted = false;
    deliveryCode = null;
    agentReview = false;
    requestId = crypto.randomUUID();
    await tick();
    replyEmailEl?.focus();
  }

  async function onCopyFullText(): Promise<void> {
    copyFailed = false;
    try {
      if (!navigator.clipboard) throw new Error('clipboard-unavailable');
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

  async function sendEnquiry(): Promise<void> {
    sending = true;
    deliveryCode = null;
    let attempted = false;
    try {
      siteKey ??= await getSiteKey();
      if (!siteKey) {
        deliveryCode = 'unavailable';
        return;
      }
      if (!turnstileToken) {
        await beginVerification();
        deliveryCode = 'verification';
        return;
      }
      attempted = true;
      const result = await submitContactEnquiry({
        ...data,
        replyEmail,
        lang,
        context,
        website: honeypot,
        turnstileToken,
        requestId,
      });
      if (destroyed) return;
      turnstileToken = '';
      if (!result.ok) {
        deliveryCode = result.code;
        challenge?.reset();
        return;
      }
      deliveryStatus = result.status;
      submitted = true;
      agentReview = false;
      challenge?.destroy();
      challenge = null;
      await tick();
      successHeadingEl?.focus();
    } catch {
      if (!destroyed) deliveryCode = attempted ? 'delivery-unknown' : 'unavailable';
    } finally {
      if (!destroyed) sending = false;
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const agentEvent = event as SubmitEvent & {
      agentInvoked?: boolean;
      respondWith?: (value: unknown) => void;
    };
    const byAgent = agentEvent.agentInvoked === true;
    const answerAgent = (text: string): void => {
      if (typeof agentEvent.respondWith === 'function') {
        agentEvent.respondWith(Promise.resolve({ content: [{ type: 'text', text }] }));
      }
    };
    if (!ready || sending || deliveryCode === 'delivery-unknown') {
      if (byAgent) answerAgent(t(lang, 'contact.agent.unavailable'));
      return;
    }
    errors = validateSubmission(data, replyEmail);
    if (Object.keys(errors).length !== 0) {
      void focusFirstError();
      if (byAgent)
        answerAgent(
          t(lang, 'contact.agent.invalid') +
            '\n' +
            FIELD_ORDER.filter((field) => errors[field])
              .map((field) => '- ' + field + ': ' + errorText(errors[field]))
              .join('\n')
        );
      return;
    }
    if (honeypot.trim()) {
      deliveryCode = 'verification';
      if (byAgent) answerAgent(t(lang, 'contact.delivery.verification'));
      return;
    }
    // An agent can fill and validate the same form, but cannot approve an
    // external email on behalf of the person. A real button press is needed.
    if (byAgent) {
      agentReview = true;
      void tick().then(() => submitEl?.focus());
      answerAgent(t(lang, 'contact.agent.review'));
      return;
    }
    agentReview = false;
    void sendEnquiry();
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
  <!-- method="dialog" is the pre-hydration guard: this island is client:idle,
       so a visitor who clicks Send in the moment between the form entering the
       viewport and the island booting would otherwise trigger a NATIVE submit —
       which navigates to ?website= and loses every answer (and, in production,
       is blocked outright by CSP form-action 'none'). Outside a <dialog>, a
       dialog-method submission is specified to do nothing at all. -->
  <form
    class="funnel glass-panel"
    method="dialog"
    aria-busy={!ready || sending}
    onsubmit={onSubmit}
    onfocusin={() => void beginVerification()}
    novalidate
    toolname="submit_project_brief"
    tooldescription={AGENT[lang].tool}
  >
    <!-- Honeypot: named for what autofill loves to fill and what a script
         loves to find, ignored by Chrome's address autofill because it
         isn't a recognized field name; removed from every human channel
         (sight, tab order, screen readers) but present to a script. -->
    <div class="funnel__hp" aria-hidden="true">
      <label for="funnel-website">{t(lang, 'contact.honeypotLabel')}</label>
      <input
        id="funnel-website"
        name="website"
        type="text"
        tabindex="-1"
        aria-hidden="true"
        toolparamdescription={t(lang, 'contact.agent.honeypot')}
        autocomplete="one-time-code"
        bind:value={honeypot}
      />
    </div>

    <div class="funnel__field">
      <label class="funnel__label text-mono" for="funnel-reply-email">{labels.replyEmail}</label>
      <input
        id="funnel-reply-email"
        name="replyEmail"
        type="email"
        autocomplete="email"
        class="funnel__input"
        disabled={!ready || sending}
        required
        aria-required="true"
        toolparamdescription={AGENT[lang].replyEmail}
        maxlength="254"
        bind:value={replyEmail}
        bind:this={replyEmailEl}
        placeholder={labels.replyEmailHint}
        aria-invalid={errors.replyEmail ? 'true' : undefined}
        aria-describedby={errors.replyEmail ? 'funnel-reply-email-error' : undefined}
      />
      {#if errors.replyEmail}<p class="funnel__error" id="funnel-reply-email-error">
          {errorText(errors.replyEmail)}
        </p>{/if}
    </div>

    <div class="funnel__field">
      <label class="funnel__label text-mono" for="funnel-company">{labels.company}</label>
      <input
        id="funnel-company"
        name="company"
        disabled={!ready || sending}
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
        disabled={!ready || sending}
        required
        toolparamdescription={AGENT[lang].task}
        class="funnel__input funnel__textarea"
        bind:value={data.task}
        bind:this={taskEl}
        placeholder={t(lang, 'contact.taskPlaceholder')}
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
          disabled={!ready || sending}
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
          disabled={!ready || sending}
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

    <button
      type="submit"
      disabled={!ready || sending || deliveryCode === 'delivery-unknown'}
      class="funnel__submit"
      bind:this={submitEl}>{sending ? t(lang, 'contact.sending') : labels.submit}</button
    >
    <div
      class="funnel__challenge"
      role="group"
      aria-label={t(lang, 'contact.verificationLabel')}
      bind:this={challengeContainer}
    ></div>
    {#if agentReview}<p class="funnel__hint" role="status">
        {t(lang, 'contact.agent.review')}
      </p>{/if}
    {#if deliveryCode}
      <p class="funnel__error" role="alert">{t(lang, 'contact.delivery.' + deliveryCode)}</p>
      <a href={mailtoUrl} class="funnel__address">{labels.openMail}</a>
      <button type="button" class="funnel__copy" onclick={() => void onCopyFullText()}
        >{t(lang, copied ? 'contact.copied' : 'contact.copyText')}</button
      >
      <details class="funnel__draft">
        <summary>{t(lang, 'contact.draftText')}</summary>
        <pre>{emailText}</pre>
      </details>
      {#if copyFailed}<p class="funnel__error" role="alert">{t(lang, 'contact.copyFailed')}</p>{/if}
    {/if}
    <p class="funnel__hint">
      {t(lang, 'contact.sendNotice')}
      <a class="funnel__address" href={'/' + lang + '/privacy/'}>{t(lang, 'footer.privacyLink')}</a>
    </p>
    <p class="funnel__direct">
      {t(lang, 'contact.directLabel')}
      <a href={'mailto:' + CONTACT_EMAIL} class="funnel__address">{CONTACT_EMAIL}</a>
    </p>
    <p class="funnel__promise text-mono">{labels.replyPromise}</p>
  </form>
{:else}
  <div class="funnel funnel--done glass-panel" role="status">
    <h2 class="funnel__done-heading" tabindex="-1" bind:this={successHeadingEl}>
      {labels.successHeading}
    </h2>
    <p class="funnel__done-body">
      {deliveryStatus === 'queued' ? t(lang, 'contact.queuedBody') : labels.successBody}
    </p>
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
    background: var(--bg-graphite);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
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
    border-color: var(--color-error);
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
    color: var(--text-primary);
    border-inline-start: 2px solid var(--color-error);
    padding-inline-start: var(--space-2);
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
  }

  /* Magnetic state: snappier follow while hovered (homepage coefficient). */
  .funnel__submit.is-magnetic {
  }

  .funnel__submit:hover {
    box-shadow:
      0 0 20px var(--accent-glow-strong),
      0 0 60px var(--accent-glow),
      inset 0 0 20px var(--accent-glow);
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
  .funnel__challenge:empty {
    display: none;
  }
  .funnel__challenge {
    max-width: 100%;
  }
  .funnel__submit:disabled {
    cursor: wait;
    opacity: 0.65;
    transform: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .funnel__input {
      transition:
        border-color var(--duration-normal) var(--ease-out),
        box-shadow var(--duration-normal) var(--ease-out);
    }
    .funnel__submit {
      transition:
        box-shadow var(--duration-normal) var(--ease-out),
        border-color var(--duration-normal) var(--ease-out),
        transform var(--duration-fast) var(--ease-out);
    }
    .funnel__address,
    .funnel__copy,
    .funnel__edit {
      transition: color var(--duration-normal) var(--ease-out);
    }
  }
</style>
