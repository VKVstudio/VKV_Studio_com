/**
 * WebMCP tool budgets — Chrome's limits, asserted against REAL output.
 *
 * Chrome truncates a tool whose name, description or output runs past its
 * budget, and a truncated answer about what a client does NOT get is worse
 * than no answer. Nothing in src/lib/webmcp clamps: these tests measure the
 * actual strings, so the day a new deliverable pushes get_service past 1500
 * characters, the suite fails and a human shortens the copy. That is the
 * intended failure — it is the only thing standing between a budget written
 * in a doc and a budget honoured in the bundle.
 *
 * Budgets verified against developer.chrome.com/docs/ai/webmcp on 2026-09-20.
 */

import { describe, it, expect } from 'vitest';
import { buildTools, BUDGET, SERVICE_IDS, LIST_LIMIT, type Lang } from '@/lib/webmcp/tools';
import { SERVICES } from '@/data/services';

const LANGS: Lang[] = ['en', 'ru'];

describe('WebMCP tools — Chrome budgets', () => {
  for (const lang of LANGS) {
    describe(`lang=${lang}`, () => {
      const tools = buildTools(lang);

      it('registers between four and six tools', () => {
        expect(tools.length).toBeGreaterThanOrEqual(BUDGET.minTools);
        expect(tools.length).toBeLessThanOrEqual(BUDGET.maxTools);
      });

      it('keeps every tool name inside 30 characters and snake_case', () => {
        for (const tool of tools) {
          expect(tool.name.length, `name too long: ${tool.name}`).toBeLessThanOrEqual(BUDGET.name);
          expect(tool.name, `name not snake_case: ${tool.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      });

      it('keeps every tool description inside 500 characters and non-empty', () => {
        for (const tool of tools) {
          expect(tool.description.length, `description empty: ${tool.name}`).toBeGreaterThan(0);
          expect(
            tool.description.length,
            `description too long: ${tool.name} (${tool.description.length})`
          ).toBeLessThanOrEqual(BUDGET.description);
        }
      });

      it('keeps every parameter description inside 150 characters', () => {
        for (const tool of tools) {
          for (const [param, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
            expect(schema.description.length, `param empty: ${tool.name}.${param}`).toBeGreaterThan(
              0
            );
            expect(
              schema.description.length,
              `param description too long: ${tool.name}.${param} (${schema.description.length})`
            ).toBeLessThanOrEqual(BUDGET.paramDescription);
          }
        }
      });

      it('never returns more than 1500 characters, for any valid input', () => {
        for (const tool of tools) {
          // Exercise every documented input, not just the empty one: an enum
          // parameter means one output per member, and the longest rung is
          // the one that would blow the budget first.
          const inputs: Record<string, unknown>[] = [{}];
          const props = tool.inputSchema?.properties ?? {};
          for (const [param, schema] of Object.entries(props)) {
            if (schema.enum) {
              for (const value of schema.enum) inputs.push({ [param]: value });
            } else {
              inputs.push({ [param]: 'contract nda data guarantee price audit' });
            }
          }
          for (const input of inputs) {
            const out = tool.execute(input);
            expect(typeof out).toBe('string');
            expect(
              out.length,
              `output too long: ${tool.name}(${JSON.stringify(input)}) = ${out.length} chars`
            ).toBeLessThanOrEqual(BUDGET.output);
            expect(out.length, `output empty: ${tool.name}`).toBeGreaterThan(0);
          }
        }
      });

      it('marks every tool read-only and its output untrusted', () => {
        // readOnlyHint spares the human an approval prompt for a lookup;
        // untrustedContentHint tells the agent our text is data, not
        // instructions. Both are the standard's own anti-injection contract —
        // a tool that loses them is a tool that can be read as a command.
        for (const tool of tools) {
          expect(tool.annotations.readOnlyHint, `not read-only: ${tool.name}`).toBe(true);
          expect(tool.annotations.untrustedContentHint, `not untrusted: ${tool.name}`).toBe(true);
        }
      });

      it('answers get_service for every rung id the ladder publishes', () => {
        const get = tools.find((t) => t.name === 'get_service');
        expect(get).toBeDefined();
        for (const id of SERVICE_IDS) {
          const out = get?.execute({ tier: id }) ?? '';
          // The rung's own URL proves it answered about THAT rung rather than
          // falling through to the ladder summary.
          expect(out, `get_service did not answer for ${id}`).toContain(`/services/${id}/`);
        }
      });

      it('publishes the exclusions of every rung, in full', () => {
        // The reason this tool exists: cramming exclusions into get_service
        // blew Chrome's output budget, and a TRUNCATED list of what a client
        // does not get is a lie by omission on the most honest part of the
        // page. So assert completeness, not merely presence — every published
        // exclusion must survive the trip to the agent.
        const excl = tools.find((t) => t.name === 'get_service_exclusions');
        expect(excl).toBeDefined();
        for (const rung of SERVICES) {
          const out = excl?.execute({ tier: rung.id }) ?? '';
          for (const item of rung.notIncluded) {
            expect(out, `${rung.id} lost an exclusion`).toContain(item[lang]);
          }
          expect(out).toContain(`/services/${rung.id}/`);
        }
      });

      it('falls back to the ladder rather than throwing on an unknown rung', () => {
        // Asserts the fallback, not merely the absence of a throw: the old
        // version of this test only demanded "does not throw", which a tool
        // returning an empty string would have satisfied — and a tool that had
        // been deleted entirely would have satisfied it too, via `?.`.
        const ladder = tools.find((t) => t.name === 'list_services')?.execute({}) ?? '';
        expect(ladder.length).toBeGreaterThan(0);
        for (const name of ['get_service', 'get_service_exclusions']) {
          const tool = tools.find((t) => t.name === name);
          expect(tool, `tool missing: ${name}`).toBeDefined();
          for (const input of [{ tier: 'no-such-rung' }, {}, { tier: null }, { tier: 42 }]) {
            let out = '';
            expect(
              () => {
                out = tool?.execute(input as Record<string, unknown>) ?? '';
              },
              `${name} threw on ${JSON.stringify(input)}`
            ).not.toThrow();
            expect(out, `${name} did not fall back to the ladder`).toBe(ladder);
          }
        }
      });

      it('declares the parameters its answers depend on', () => {
        // Without inputSchema an agent has no way to learn that `tier` exists,
        // so it calls the tool bare — and both rung tools then return the
        // ladder summary rather than an error. The failure is silent and total:
        // deliverables and exclusions become unreachable while every other test
        // in this file stays green. Hence an explicit assertion on the schema.
        for (const name of ['get_service', 'get_service_exclusions']) {
          const tool = tools.find((t) => t.name === name);
          const schema = tool?.inputSchema;
          expect(schema, `${name} declares no inputSchema`).toBeDefined();
          expect(schema?.required, `${name} does not require tier`).toContain('tier');
          const tier = schema?.properties['tier'];
          expect(tier?.type).toBe('string');
          expect(tier?.enum, `${name} does not enumerate the rungs`).toEqual([...SERVICE_IDS]);
        }
        const faq = tools.find((t) => t.name === 'search_faq');
        expect(faq?.inputSchema?.required, 'search_faq does not require query').toContain('query');
      });

      it('keeps the truncation valve dormant', () => {
        // LIST_LIMIT is the one clamp in the module. Today no published list
        // reaches it, so no answer is ever cut — and that is worth asserting
        // rather than assuming, because a cut list of what a client does NOT
        // get is the most expensive kind of half-truth this site could tell.
        // When a rung outgrows the valve this fails, and a human decides.
        for (const rung of SERVICES) {
          expect(
            rung.deliverables.length,
            `${rung.id} deliverables would be truncated for an agent`
          ).toBeLessThanOrEqual(LIST_LIMIT);
          expect(
            rung.notIncluded.length,
            `${rung.id} exclusions would be truncated for an agent`
          ).toBeLessThanOrEqual(LIST_LIMIT);
        }
      });

      it('points an unanswerable FAQ question at the contact page', () => {
        const faq = tools.find((t) => t.name === 'search_faq');
        const out = faq?.execute({ query: 'zzzz qqqq xxxx' }) ?? '';
        expect(out).toContain(`/${lang}/contact/`);
      });

      it('answers a real FAQ question from the published corpus', () => {
        const faq = tools.find((t) => t.name === 'search_faq');
        const out = faq?.execute({ query: lang === 'ru' ? 'договор' : 'contract' }) ?? '';
        expect(out.length).toBeGreaterThan(40);
        expect(out).not.toContain('/contact/');
      });

      it('quotes prices in EUR and never names a payment method we cannot take', () => {
        // The site's two absolute content laws, enforced here too: an agent
        // repeating a dollar price or the word Stripe would be quoting us.
        for (const tool of tools) {
          const props = tool.inputSchema?.properties ?? {};
          const inputs: Record<string, unknown>[] = [{}];
          for (const [param, schema] of Object.entries(props)) {
            for (const value of schema.enum ?? ['price']) inputs.push({ [param]: value });
          }
          for (const input of inputs) {
            const out = tool.execute(input);
            expect(out.toLowerCase(), `Stripe named by ${tool.name}`).not.toContain('stripe');
            expect(out, `dollar price from ${tool.name}`).not.toMatch(/\$\s?\d/);
          }
        }
      });
    });
  }

  it('offers the same tool names in both languages', () => {
    const en = buildTools('en').map((t) => t.name);
    const ru = buildTools('ru').map((t) => t.name);
    expect(ru).toEqual(en);
  });

  it('gives every tool a distinct name', () => {
    const names = buildTools('en').map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
