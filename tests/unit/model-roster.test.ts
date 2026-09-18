/**
 * Guards the join between the two model rosters.
 *
 * The Prompt Architect prices a prompt from `prompt/builder.ts`'s MODELS but
 * COUNTS it through `tokenizer/engine.ts`'s MODELS, via
 * `tokenize(text, model.id as ModelId)`. That `as ModelId` cast is the whole
 * problem: it satisfies the compiler while telling it something false, so a
 * row present in one file and absent from the other type-checks cleanly and
 * fails at runtime.
 *
 * That is not hypothetical. `claude-opus-5` and `gemini-3.6-flash` were added
 * to builder.ts on 2026-08-09 and not to engine.ts. Selecting either threw
 * inside `getModelInfo`, the UI caught it and kept the PREVIOUS model's token
 * counts, and the `$derived` cost then recomputed the NEW model's price
 * against those stale counts — so the most expensive model in the roster
 * displayed a wrong dollar figure beside an error banner, in the tool whose
 * entire pitch is that its numbers are honest.
 *
 * A functional test would not have caught it: every individual model works.
 * The defect only exists in the relationship between two files, which is
 * exactly what this asserts.
 */
import { describe, it, expect } from 'vitest';
import { MODELS as TOKENIZER_MODELS, MODEL_LIST } from '@/lib/tokenizer/engine';
import { MODELS as PRICED_MODELS } from '@/lib/prompt/builder';

describe('model roster join', () => {
  it('every priced model can be tokenized', () => {
    const missing = PRICED_MODELS.filter((m) => !(m.id in TOKENIZER_MODELS)).map((m) => m.id);
    expect(
      missing,
      `priced in builder.ts but absent from tokenizer/engine.ts: ${missing.join(', ')}`
    ).toEqual([]);
  });

  /**
   * Deliberately unpriced, with the reason, so this stays an allowlist and not
   * a loophole. `llama-4-scout` is tokenizable (open weights, real vocabulary)
   * but carries no cost row: builder.ts:258-259 records that no matching id
   * existed in the live OpenRouter catalog when the roster was verified, and
   * the author chose to omit it from cost estimation rather than invent a
   * number. Removing an id from this list without adding a price is a real
   * defect; adding one requires the same kind of written reason.
   */
  const UNPRICED_BY_DESIGN = new Set(['llama-4-scout']);

  it('every tokenizable model is either priced or knowingly unpriced', () => {
    const priced = new Set(PRICED_MODELS.map((m) => m.id));
    const missing = MODEL_LIST.filter((id) => !priced.has(id) && !UNPRICED_BY_DESIGN.has(id));
    expect(missing, `tokenizable but silently unpriced: ${missing.join(', ')}`).toEqual([]);
  });

  it('the unpriced allowlist has no stale entries', () => {
    // If a price later appears for one of these, the exception should go too —
    // otherwise the allowlist quietly grants cover it no longer needs.
    const priced = new Set(PRICED_MODELS.map((m) => m.id));
    const stale = [...UNPRICED_BY_DESIGN].filter((id) => priced.has(id));
    expect(stale, `now priced, so drop from UNPRICED_BY_DESIGN: ${stale.join(', ')}`).toEqual([]);
  });

  it('the hidden-reasoning disclosure survives the join', () => {
    // builder.ts derives `reasoningCapable` from the tokenizer roster. If a row
    // is missing there, the lookup yields undefined and the "you are billed for
    // tokens you never see" warning silently does not render — worst on exactly
    // the frontier models where it matters most.
    for (const m of PRICED_MODELS) {
      const info = TOKENIZER_MODELS[m.id as keyof typeof TOKENIZER_MODELS];
      expect(
        info,
        `no tokenizer entry for ${m.id}, so its reasoning disclosure cannot resolve`
      ).toBeDefined();
    }
  });
});
