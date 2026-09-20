/**
 * The declarative half of WebMCP: the contact form's agent-facing markup.
 *
 * This reads the COMPONENT SOURCE rather than a rendered page, because the
 * attributes must be present in the server-rendered HTML — ContactFunnel is a
 * client:visible island, so anything added at hydration would arrive after an
 * agent has already parsed the form. The project has no component-rendering
 * test harness (28 suites, none of them mount anything), so source analysis is
 * the house idiom; what it costs in fidelity is paid back below by stripping
 * comments first and anchoring each assertion to its element.
 *
 * WHY THE STRIPPING MATTERS: an audit on 2026-09-20 showed the first version of
 * this file was partly vacuous. Deleting the respondWith() call — the entire
 * point of the agent path — left all ten tests green, because the words it
 * searched for also appear in the comments explaining them. A test that cannot
 * fail is worse than no test: it buys confidence nothing earned. Everything
 * here now runs against CODE, with the comments removed.
 *
 * Lighthouse's "WebMCP schema validity" audit is the only one of the three
 * agentic-browsing audits that can actually FAIL a page. It fails when a form
 * carries tooldescription without toolname (or the reverse), and when a
 * required field has no `name`. Both conditions are asserted below, so the
 * audit cannot regress without the suite going red first.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAW = readFileSync(
  resolve(process.cwd(), 'src/components/contact/ContactFunnel.svelte'),
  'utf-8'
);

/**
 * The component with every comment removed — block, line and HTML — so a
 * sentence ABOUT the code can never satisfy an assertion about the code.
 * String literals are left intact: they are the thing being measured.
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(RAW);

/** The markup half only — everything after the instance script closes. */
const TEMPLATE = CODE.slice(CODE.indexOf('</script>'));

/** The opening `<form ...>` tag, so form-level attributes cannot be satisfied
 *  by something sitting on an input somewhere else in the file. */
const FORM_TAG = /<form\b[^>]*>/.exec(TEMPLATE)?.[0] ?? '';

/** The opening tag of one named control, by its id. */
function tagOf(id: string): string {
  const re = new RegExp(`<(input|textarea|select)\\b[^>]*\\bid="${id}"[^>]*>`);
  return re.exec(TEMPLATE)?.[0] ?? '';
}

const FIELDS = [
  { id: 'funnel-company', name: 'company' },
  { id: 'funnel-task', name: 'task' },
  { id: 'funnel-budget', name: 'budget' },
  { id: 'funnel-timeline', name: 'timeline' },
] as const;

/** Chrome's budgets, restated here so this file fails on its own terms. */
const NAME_MAX = 30;
const DESCRIPTION_MAX = 500;
const PARAM_MAX = 150;

describe('ContactFunnel — declarative WebMCP', () => {
  it('finds the form and all four controls to assert against', () => {
    // Guard on the guards: if the selectors above ever stop matching, every
    // assertion below would pass against an empty string. This test is what
    // makes the rest of the file non-vacuous.
    expect(FORM_TAG, 'the <form> tag was not found').not.toBe('');
    for (const f of FIELDS) {
      expect(tagOf(f.id), `control not found: ${f.id}`).not.toBe('');
    }
  });

  it('pairs toolname with tooldescription on the form element itself', () => {
    // Either attribute alone is exactly what the Lighthouse audit fails on.
    expect(FORM_TAG, 'toolname missing from <form>').toMatch(/\btoolname="submit_project_brief"/);
    expect(FORM_TAG, 'tooldescription missing from <form>').toMatch(/\btooldescription=/);
  });

  it('keeps the tool name inside Chrome’s 30-character budget', () => {
    const match = /\btoolname="([^"]+)"/.exec(FORM_TAG);
    expect(match).not.toBeNull();
    expect(match?.[1]?.length ?? 999).toBeLessThanOrEqual(NAME_MAX);
  });

  it('gives every answer field its own name and description, on its own tag', () => {
    // Anchored per element: an attribute that drifted onto the wrong control
    // used to keep this green, because the old assertion only grepped the file.
    for (const field of FIELDS) {
      const tag = tagOf(field.id);
      expect(tag, `missing name: ${field.id}`).toMatch(new RegExp(`\\bname="${field.name}"`));
      expect(tag, `missing toolparamdescription: ${field.id}`).toMatch(
        new RegExp(`\\btoolparamdescription=\\{AGENT\\[lang\\]\\.${field.name}\\}`)
      );
    }
  });

  it('tells an agent plainly not to fill the honeypot', () => {
    // The honeypot is in the schema Chrome publishes whether we describe it or
    // not — it is a named control, and it sorts FIRST. Leaving it undescribed
    // (the original choice) meant an agent read a field called `website` whose
    // only hint was the visually-hidden label "Leave this field empty": a
    // mixed signal, and the first thing an agent learns about this studio.
    // An explicit instruction is clearer and costs nothing, since the gate is
    // skipped for agent submissions anyway.
    const tag = tagOf('funnel-website');
    expect(tag, 'honeypot control not found').not.toBe('');
    expect(tag).toMatch(/\bname="website"/);
    expect(tag, 'honeypot is undescribed').toMatch(/\btoolparamdescription="[^"]+"/);
    expect(tag, 'the honeypot description must say not to fill it').toMatch(
      /toolparamdescription="[^"]*[Dd]o not fill/
    );
  });

  it('declares all four answer fields required, so the published schema is honest', () => {
    // Chrome synthesises the tool's inputSchema from the form. Without the
    // `required` content attribute it publishes `"required": []` — found in the
    // live PageSpeed report on 2026-09-20 — which invites a compliant agent to
    // omit fields that validation then rejects. aria-required is not enough:
    // Blink reads element.IsRequired(). The form carries `novalidate`, so this
    // changes the contract for agents without turning on native browser bubbles
    // for humans.
    // The boundary has to exclude `aria-required`, which every control also
    // carries: `\brequired\b` matches inside it, because a hyphen is not a
    // word character. The first version of this assertion did exactly that and
    // stayed green when the real attribute was deleted — caught by mutating it.
    const BARE_REQUIRED = /(?:^|\s)required(?=\s|=|>|$)/m;
    for (const field of FIELDS) {
      const tag = tagOf(field.id);
      expect(tag, `not required: ${field.id}`).toMatch(BARE_REQUIRED);
      expect(tag, `aria-required alone is not enough: ${field.id}`).toMatch(/aria-required/);
    }
    expect(FORM_TAG, 'novalidate was removed; native bubbles would appear').toMatch(
      /\bnovalidate\b/
    );
  });

  it('never sets toolautosubmit anywhere in the markup', () => {
    // toolautosubmit turns the agent's submission into a real navigation,
    // which this site's CSP (form-action 'none') refuses outright — the agent
    // would get no answer and the visitor would lose every answer typed.
    // Asserted against comment-free markup, so the component may keep
    // explaining at length why it does not set this.
    expect(TEMPLATE).not.toMatch(/\btoolautosubmit\b/);
  });

  it('keeps the form a dialog-method submit', () => {
    // The pre-hydration guard AND the reason the CSP is never consulted: a
    // dialog-method submission outside a <dialog> is specified to do nothing.
    expect(FORM_TAG).toMatch(/\bmethod="dialog"/);
  });

  it('holds every agent-facing string inside Chrome’s budgets', () => {
    const block = CODE.slice(CODE.indexOf('const AGENT'), CODE.indexOf('let submitEl'));
    expect(block.length, 'AGENT block not found').toBeGreaterThan(200);

    // Both quote styles: Prettier rewrites a single-quoted string to double
    // quotes the moment its text contains an apostrophe, and this file used to
    // demand exactly ten single-quoted matches — so one English contraction in
    // the copy would have broken the test rather than the code. (Apostrophes
    // have bitten this repository three times already.)
    const strings = [
      ...block.matchAll(
        /\b(tool|company|task|budget|timeline):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
      ),
    ];
    expect(strings.length, 'expected ten agent strings (five per language)').toBe(10);

    for (const [, key, single, double] of strings) {
      const text = (single ?? double ?? '').replace(/\\u2019/g, '’').replace(/\\(['"])/g, '$1');
      expect(text.length, `empty: ${key}`).toBeGreaterThan(0);
      const limit = key === 'tool' ? DESCRIPTION_MAX : PARAM_MAX;
      expect(text.length, `over budget: ${key} (${text.length} > ${limit})`).toBeLessThanOrEqual(
        limit
      );
    }
  });

  it('answers an agent on success with the composed email', () => {
    // Matched against comment-free CODE and against the CALL, not the bare
    // identifier: an earlier version of this test passed while respondWith had
    // been deleted, because the words survived in the comments explaining them.
    expect(CODE, 'the agent branch is gone').toMatch(/agentEvent\.agentInvoked\s*===\s*true/);
    expect(CODE, 'respondWith is never CALLED').toMatch(/agentEvent\.respondWith\s*\(/);
    expect(CODE, 'respondWith is called unguarded').toMatch(
      /typeof agentEvent\.respondWith === 'function'/
    );
    expect(CODE, 'the success path does not answer with the composed email').toMatch(
      /answerAgent\(buildEmailText\(data, lang\)\)/
    );
  });

  it('answers an agent when its submission FAILS validation', () => {
    // The defect this test exists for (audit, 2026-09-20): the invalid branch
    // ended in a bare `return`, so a compliant agent that omitted a field —
    // which the published schema invited, since `required` was empty — got
    // Chromium's "the site has a programming error" instead of the field
    // errors. The ordering test below stayed green the whole time, because
    // order was all it checked.
    const invalidBlock = CODE.slice(
      CODE.indexOf('if (!isValid(errors))'),
      CODE.indexOf('if (byAgent) {', CODE.indexOf('if (!isValid(errors))') + 40)
    );
    expect(invalidBlock.length, 'the invalid-submit block was not found').toBeGreaterThan(20);
    const failurePath = CODE.slice(
      CODE.indexOf('if (!isValid(errors))'),
      CODE.indexOf('// WebMCP: an agent filled')
    );
    expect(failurePath, 'the failure path never answers the agent').toMatch(/answerAgent\(/);
    expect(failurePath, 'the failure path does not report which fields failed').toMatch(
      /errors\[f\]/
    );
  });

  it('orders the submit guards: validate, then agent, then honeypot', () => {
    // Order is the whole safety argument. Validation runs first, so a real
    // visitor's errors are never suppressed; the agent branch sits before the
    // honeypot gate, so an agent that dutifully filled every field is not
    // silently swallowed by the anti-script trap. Anchored on the guards
    // themselves — `byAgent` is only a boolean read and may be computed
    // anywhere above.
    const validation = CODE.indexOf('errors = validate(data)');
    const invalid = CODE.indexOf('if (!isValid(errors))');
    const agentSuccess = CODE.indexOf('answerAgent(buildEmailText');
    const gate = CODE.indexOf('isGateTripped(honeypot');
    expect(validation, 'validation call not found').toBeGreaterThan(-1);
    expect(invalid, 'invalid guard not found').toBeGreaterThan(validation);
    expect(agentSuccess, 'agent success path not found').toBeGreaterThan(invalid);
    expect(gate, 'honeypot gate not found').toBeGreaterThan(agentSuccess);
  });

  it('keeps the island server-rendered, which is the only reason any of this reaches an agent', () => {
    // Declarative WebMCP is read from parsed HTML. A client:only directive
    // would leave the form empty in the served markup, and every assertion
    // above would still pass while an agent saw nothing at all.
    const page = readFileSync(
      resolve(process.cwd(), 'src/pages/[lang]/contact/index.astro'),
      'utf-8'
    );
    expect(page).toMatch(/<ContactFunnel\b[^>]*\bclient:visible/);
    expect(page, 'client:only would strip the form from the served HTML').not.toMatch(
      /<ContactFunnel\b[^>]*\bclient:only/
    );
  });
});
