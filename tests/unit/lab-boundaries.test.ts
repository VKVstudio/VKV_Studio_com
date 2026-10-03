import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { applyVariables, variableValue } from '@/lib/prompt/builder';

// Exercise the actual async handlers with controlled pending I/O. This does not
// replace browser hydration checks; no provider, model or real session is used.
function harness(path: string, functions: string[], seed: Record<string, unknown>, effect = false) {
  const raw = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  const source = raw.endsWith('</script>') ? raw : (raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? raw);
  const ast = ts.createSourceFile(path + '.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text));
  expect(selected).toHaveLength(functions.length);
  let code = selected.map((node) => node.getText(ast)).join('\n');
  if (effect) {
    const statement = ast.statements.find((node) => ts.isExpressionStatement(node)
      && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === '$effect'
      && node.getText(ast).includes('clearTimeout('));
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error('Missing input effect');
    code += '\nglobalThis.runEffect = ' + statement.expression.arguments[0]!.getText(ast) + ';';
  }
  const context = createContext({ AbortController, DOMException, performance, console: { warn: vi.fn() },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), ...seed });
  runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Lab input and response boundaries', () => {
  it('preserves unresolved prototype names and accepts explicitly supplied strings', () => {
    const text = '{{constructor}} {{toString}} {{__proto__}}';
    expect(applyVariables(text, {})).toBe(text);
    expect(variableValue({}, 'constructor')).toBeUndefined();
    expect(applyVariables(text, JSON.parse('{"constructor":"custom","toString":"","__proto__":"safe"}'))).toBe('custom  safe');
    expect(applyVariables('{{x}}', Object.create({ x: 'inherited' }))).toBe('{{x}}');
    expect(variableValue(JSON.parse('{"x":42}'), 'x')).toBeUndefined();
  });

  it.each([-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null])('rejects invalid provider count %s', async (count) => {
    const fallback = vi.fn(() => ({ accuracy: 'approx', fallbackReason: 'provider' }));
    const ctx = harness('src/lib/tokenizer/engine.ts', ['tokenizeWithAPI'], {
      SYNAPSE_API_BASE: 'https://fixture.invalid',
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ totalTokens: count }) })),
      tokenizeWithTiktokenFallback: fallback,
    });
    const result = await ctx.tokenizeWithAPI('text', { id: 'fixture' });
    expect(result.accuracy).toBe('approx');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it.each([0, 12])('accepts valid provider count %s', async (count) => {
    const ctx = harness('src/lib/tokenizer/engine.ts', ['tokenizeWithAPI'], {
      SYNAPSE_API_BASE: 'https://fixture.invalid',
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ totalTokens: count }) })),
      countCodepoints: (text: string) => text.length,
    });
    const result = await ctx.tokenizeWithAPI('text', { id: 'fixture' });
    expect(result.totalTokens).toBe(count);
    expect(result.accuracy).toBe('verified');
  });

  it.each([200, 401])('prompt generation carries current authentication and handles HTTP %s', async (status) => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: status === 200, status, json: async () => ({ response: '[USER]\nSafe fixture' }) }));
    const generated = vi.fn();
    const ctx = harness('src/components/lab/prompt/MetaPromptGenerator.svelte', ['handleGenerate', 'buildGenerationPrompt'], {
      userInput: 'fixture task', selectedModel: 'fixture', selectedStyle: 'structured', lang: 'en',
      isGenerating: false, genError: null, GENERATE_TIMEOUT_MS: 120000,
      SYNAPSE_API_BASE: 'https://fixture.invalid', getIdToken: () => 'synthetic-session-token', fetch,
      t: (_lang: string, key: string) => key, onGenerated: generated,
    });
    await ctx.handleGenerate();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer synthetic-session-token');
    expect(ctx.isGenerating).toBe(false);
    if (status === 200) expect(generated).toHaveBeenCalledOnce();
    else { expect(generated).not.toHaveBeenCalled(); expect(ctx.genError).toBe('prompt.generateSignIn'); }
  });

  it.each([true, false])('Tokenizer rejects late results during input change (effect flushed: %s)', async (flush) => {
    const pending = deferred<unknown>();
    const ctx = harness('src/components/lab/tokenizer/TokenizerApp.svelte', ['performTokenize', 'copyResult'], {
      text: 'old text', model: 'old-model', inputMode: 'raw', latestRequestId: 0, activeController: null,
      isTyping: false, result: null, resultContext: null, resultIsCurrent: false, displayedMode: 'raw',
      usedFallback: false, displayTokens: 0, displayChars: 0, displayDensity: 0, displayLatencyMs: 0,
      debounceTimer: undefined, getDebounceDelay: () => 500, tokenize: () => pending.promise,
      tokenizerStatus: 'ready', statusModel: null, navigator: { clipboard: { writeText: vi.fn() } },
    }, true);
    const run = ctx.performTokenize('old text', 'old-model', 'raw');
    const signal = ctx.activeController.signal;
    ctx.text = 'new text'; ctx.model = 'new-model';
    if (flush) { ctx.runEffect(); expect(signal.aborted).toBe(true); }
    pending.resolve({ totalTokens: 37, totalChars: 8, density: 1, latencyMs: 1, tokens: [], accuracy: 'verified' });
    await run;
    expect(ctx.result).toBeNull();
    await ctx.copyResult();
    expect(ctx.navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('comparison cancels both old requests immediately and ignores their late pair', async () => {
    const pending = deferred<unknown>();
    const ctx = harness('src/components/lab/tokenizer/TokenCompare.svelte', ['runCompare'], {
      text: 'old', modelA: 'a', modelB: 'b', latestRequestId: 0, activeController: null,
      resultA: null, resultB: null, isLoading: true, compareError: false, runTimer: undefined,
      tokenize: () => pending.promise, getCompareDebounce: () => 500,
    }, true);
    const run = ctx.runCompare('old', 'a', 'b');
    const signal = ctx.activeController.signal;
    ctx.text = 'new'; ctx.runEffect();
    expect(signal.aborted).toBe(true);
    pending.resolve({ totalTokens: 37 }); await run;
    expect(ctx.resultA).toBeNull(); expect(ctx.resultB).toBeNull(); expect(ctx.isLoading).toBe(true);
  });

  it('prompt edits cannot receive token counts from the superseded snapshot', async () => {
    const pending = deferred<unknown>();
    const ctx = harness('src/components/lab/prompt/PromptApp.svelte', ['recomputeTokens', 'getCountText'], {
      selectedModel: { id: 'a' }, blocks: [{ id: 'block', content: 'old', tokens: 0 }],
      latestRequestId: 0, activeController: null, isCalculating: false, calcError: false,
      isInitialCount: true, lastCalcModel: 'a', lastCalcContents: {}, lastCalcAccuracy: {}, countAccuracy: null,
      debounceTimer: undefined, countMode: 'template', countTokens: () => pending.promise,
    }, true);
    const run = ctx.recomputeTokens([{ id: 'block', text: 'old' }], { id: 'a' });
    const signal = ctx.activeController.signal;
    ctx.blocks[0].content = 'new'; ctx.runEffect();
    expect(signal.aborted).toBe(true);
    pending.resolve({ tokens: 37, accuracy: 'native' }); await run;
    expect(ctx.blocks[0].tokens).toBe(0); expect(ctx.lastCalcContents).toEqual({});
    expect(ctx.isCalculating).toBe(true);
  });
});
