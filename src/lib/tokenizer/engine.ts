// `js-tiktoken/lite` is the ~100-byte BPE runtime with NO vocabulary attached.
// The package's main entry (`encodingForModel`) statically pulls every rank
// table it ships — o200k, cl100k, p50k, p50k_edit, r50k and gpt2 — which put
// 5.35 MB (2.47 MB gzipped) into this module's chunk. Because `builder.ts`
// imports from here, that weight landed on the Prompt Architect page too,
// where a tokenizer vocabulary may never be touched at all. Only two of the
// six tables are ever reachable (see `getTiktokenEncoder`), and both now load
// as data on first use instead of as code at hydration.
import { Tiktoken } from 'js-tiktoken/lite';
import { countOffThread } from './count-offthread';
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import { SYNAPSE_API_BASE } from '../api-config';

export type ModelId =
  | 'gemini-3.1-pro'
  | 'gemini-3.5-flash'
  | 'gemini-3.6-flash'
  | 'gemini-3.7-flash'
  | 'gemma-4-e2b'
  | 'claude-fable-5'
  | 'claude-opus-4.8'
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'claude-haiku-4-5'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  // 'gpt-5.5' / 'gpt-5.5-pro' were removed 2026-08-15 with their MODELS entries
  // and their builder.ts price rows — OpenAI publishes neither id any more. They
  // lingered in this union by a missed edit, and because `astro build` does not
  // type-check, nothing caught the mismatch: MODELS no longer had those keys,
  // so `Record<ModelId, ModelInfo>` was unsatisfiable and MODELS[id] could have
  // been undefined at runtime for an id the union still advertised. `tsc
  // --noEmit` is what found it.
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash'
  | 'qwen-3.7-max'
  | 'mistral-large-3'
  | 'llama-4-scout'
  | 'glm-5.2';

export type TokenizerBackend =
  | { type: 'tiktoken'; encoding: 'o200k_base' }
  | { type: 'transformers'; repo: string; vocabSize: number }
  | { type: 'api'; provider: 'anthropic' | 'google' };

export interface ModelInfo {
  id: ModelId;
  name: string;
  vocabSize: number;
  backend: TokenizerBackend;
  /**
   * True when this model has hidden/billable "reasoning" tokens (extended
   * thinking / chain-of-thought the provider generates and bills as output
   * but never returns in the visible response). Purely a disclosure flag for
   * the UI — tokenize() never estimates a reasoning-token count from it (the
   * count is decided at generation time and isn't observable from a plain
   * tokenize call), so this must never feed into any arithmetic here.
   */
  hiddenReasoning?: boolean;
  /**
   * True when this model is closed-weight with no published tokenizer, so
   * `backend` is a nearest-open-vocab substitute from a different (but
   * related) model — NOT this model's own tokenizer. Forces tokenize() to
   * downgrade an otherwise-'native' result to 'approx' with
   * `fallbackReason: 'closedWeight'`, so the badge never claims byte-exact
   * accuracy the substitute vocab can't actually deliver. See the
   * 'qwen-3.7-max' entry below for why this exists.
   */
  closedWeightApprox?: boolean;
  /**
   * True when this model's 'verified' accuracy tier — though a genuine
   * provider-API round-trip — is computed server-side against a DIFFERENT
   * underlying model, per inference/main.py's `map_model_name` (e.g. Fable 5
   * and Opus 4.8 currently have no direct Anthropic API access and silently
   * resolve to a Sonnet snapshot there). The count is real, just not from
   * this exact model — the UI must show a qualified tooltip instead of the
   * unqualified "Verified — provider API count" message so the badge never
   * overclaims. See tokenizer namespace's `accuracyVerifiedSameFamilyTooltip`.
   */
  verifiedViaSameFamilyModel?: boolean;
}

export interface Token {
  id: number;
  text: string;
  hue: number;
  bytes: number[];
  /**
   * True when this token's decoded text is a broken/partial multibyte UTF-8
   * sequence (decode([id]) produced U+FFFD replacement character(s)) — i.e.
   * this single BPE token is one piece of a multi-token codepoint (extremely
   * common for Cyrillic/CJK/emoji). When true, `text`/`bytes` above are NOT
   * the token's real bytes — see `isPartialByteSequence` for why neither
   * js-tiktoken nor @huggingface/transformers expose a true per-token byte
   * API here, so callers must not present them as fact.
   */
  partial?: boolean;
}

/**
 * Detects whether a single-token decode is a broken/partial multibyte UTF-8
 * sequence. Both js-tiktoken's `Tiktoken.decode()` and transformers.js'
 * `PreTrainedTokenizer.decode()` go through a UTF-8 TextDecoder under the
 * hood; when a single token's bytes are only *part* of a multi-byte
 * codepoint (common for Cyrillic/CJK/emoji BPE splits), that decode yields
 * the U+FFFD replacement character instead of the real character. Any
 * bytes re-derived from that decoded string (e.g. `TextEncoder.encode(...)`)
 * are therefore NOT the token's real bytes — just the encoding of U+FFFD.
 * Neither library exposes a true per-token byte API to get around this
 * (verified: js-tiktoken's `Tiktoken` class only exposes `encode`/`decode`,
 * no `decode_single_token_bytes`-equivalent), so this is the honest signal
 * to flag those tokens rather than silently showing fabricated bytes.
 */
function isPartialByteSequence(decodedText: string): boolean {
  return decodedText.includes('�');
}

/** Codepoint-accurate character count — `text.length` counts UTF-16 code
 *  units, which double-counts astral-plane characters (most emoji, some CJK
 *  extensions) as 2. Spreading a string iterates by codepoint. */
function countCodepoints(text: string): number {
  return [...text].length;
}

/**
 * Accuracy tier of a tokenize() result — MUST be set explicitly on every
 * return path, never inferred by callers from `tokens.length`:
 * - 'native'   — on-device tokenizer (tiktoken / transformers.js), byte-exact for that model.
 * - 'verified' — provider API round-trip succeeded (HTTP ok + valid JSON); count is authoritative.
 * - 'approx'   — provider API was unreachable/failed; falling back to a cl100k_base heuristic count.
 */
export type Accuracy = 'native' | 'verified' | 'approx';

/**
 * WHY a result fell back to 'approx' — only set when `accuracy === 'approx'`.
 * Distinguishes a genuinely-unreachable backend from a backend that IS up but
 * whose upstream provider (Anthropic/Google) rejected the request (billing,
 * rate limit, bad request, etc.) — these are different failures and must not
 * share a "backend offline" message when the backend answered just fine.
 * - 'network'      — the fetch to our own FastAPI backend itself failed
 *                     (unreachable / DNS / connection refused / timeout).
 * - 'provider'      — our backend responded, but with a non-OK status or an
 *                     invalid payload — almost always the upstream provider
 *                     API rejecting the request, not our backend being down.
 * - 'onDeviceLoad'  — the on-device transformers.js tokenizer (Gemma/DeepSeek/
 *                     Qwen/Mistral vocab) failed to load — unrelated to the
 *                     backend or any provider entirely.
 * - 'closedWeight'   — not a failure at all: the on-device tokenize() call
 *                     succeeded, but the model is closed-weight with no
 *                     published tokenizer, so the result comes from a
 *                     nearest-open-vocab substitute (see
 *                     `ModelInfo.closedWeightApprox`) rather than the
 *                     model's own tokenizer — deliberately downgraded from
 *                     'native' so the badge can't overclaim.
 */
export type FallbackReason =
  | 'network'
  | 'provider'
  | 'onDeviceLoad'
  | 'closedWeight'
  /** No request was attempted — the caller asked for a local-only count. */
  | 'notRequested';

/**
 * Honesty tier of a chatOverhead computation — MUST match how the number was
 * actually produced, never upgraded for a nicer-looking badge:
 * - 'native'      — the model's own tokenizer applied its real chat_template
 *                    (transformers.js `apply_chat_template`); byte-exact overhead.
 * - 'documented'  — OpenAI's publicly documented ChatML accounting formula
 *                    (not measured against a live tokenizer, but not guessed either).
 * - 'estimated'   — a conservative placeholder constant because no on-device
 *                    template or documented formula is available (Anthropic/Google
 *                    APIs, or a transformers.js model with no chat_template).
 */
export type ChatOverheadExactness = 'native' | 'documented' | 'estimated';

export interface ChatOverhead {
  /** Token count of the text wrapped as a single chat turn (role markers etc. included). */
  wrappedTotal: number;
  /** wrappedTotal - raw totalTokens */
  overhead: number;
  exactness: ChatOverheadExactness;
}

export interface TokenResult {
  tokens: Token[];
  totalTokens: number;
  totalChars: number;
  density: number; // chars per token
  /**
   * Wall-clock milliseconds for the tokenize() call itself (encode + decode
   * for on-device backends; full request round-trip for the API backend).
   * A genuine `performance.now()` measurement, not a derived/inflated
   * "tokens/sec" figure — small on-device inputs finish in low single-digit
   * ms or less, which the UI renders as "<1 ms" rather than fake precision.
   */
  latencyMs: number;
  accuracy: Accuracy;
  /** Only present when accuracy === 'approx' — see FallbackReason. */
  fallbackReason?: FallbackReason;
  /** Only present when tokenize() was called with { includeChatTemplate: true }. */
  chatOverhead?: ChatOverhead;
}

export type TokenizerStatus =
  | 'ready' // tiktoken — мгновенно
  | 'loading' // transformers — загружается vocab
  | 'fetching' // API — ждём ответ
  | 'error'; // ошибка

/** Per-call options for tokenize() — no module-level/global state. */
export interface TokenizeOptions {
  /** Called with status transitions for THIS call only (loading/fetching/ready/error). */
  onStatus?: (status: TokenizerStatus, model: ModelId) => void;
  /** Abort the in-flight provider fetch (api backend only). */
  signal?: AbortSignal;
  /**
   * When true, also compute `TokenResult.chatOverhead` — the cost of wrapping
   * `text` as a single chat/user turn instead of counting it as raw text.
   * Left false (default) in "Raw text" mode so that path stays exactly as
   * cheap and unchanged as before this feature existed.
   */
  includeChatTemplate?: boolean;
  /**
   * Set false to forbid this call from touching the network: `api`-backend
   * models fall straight through to the local tiktoken approximation, tagged
   * `notRequested`.
   *
   * Exists for counts nobody asked for. The Prompt Architect opens with a
   * default system block already filled in and a default model whose backend is
   * `api`, so every page load fired a cross-origin POST for text the visitor had
   * not written or looked at. With no inference server deployed that request
   * cannot succeed, and the browser logs the failure — which is a real
   * Lighthouse best-practices failure, but more to the point it is an
   * unrequested network call whose result nobody is waiting for.
   *
   * Defaults to true, so every existing caller behaves exactly as before.
   */
  allowNetwork?: boolean;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  // OpenAI — js-tiktoken
  // o200k_harmony note: that encoding belongs to OpenAI's OPEN-WEIGHT gpt-oss
  // models (the ones you self-host), not the hosted GPT-5.x API family this
  // entry represents. The GPT-5.x API itself uses o200k_base — same encoding
  // as gpt-4o — so 'o200k_base' below is correct as-is, not a placeholder.
  // (Previously this comment claimed the opposite — that GPT-5.5 "should" use
  // o200k_harmony and was only on o200k_base because js-tiktoken lacked
  // support. That was a misattribution; fixed 2026-07-09, no code change.)
  // GPT-5.6 — GA 2026-07-09, three tiers, verified against
  // developers.openai.com/api/docs/models. `gpt-5.6` is an alias for Sol.
  // There is deliberately NO "-pro" row: OpenAI documents that pro is a
  // `reasoning.mode` flag on the same model, not a separate model id, and
  // says outright not to switch to a separate Pro slug.
  // Encoding caveat, stated honestly: OpenAI publishes no encoding for 5.6,
  // and tiktoken's own map has no gpt-5.6 entry. o200k_base is an inference
  // from there being no newer encoding (o200k_harmony is gpt-oss-only) and
  // the whole GPT-5 line using it. Safe regardless — getTiktokenEncoder()
  // below dispatches on the ENCODING name and hardcodes 'gpt-4o' as the
  // js-tiktoken model argument, so the model id here is never passed to it.
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    vocabSize: 201088,
    hiddenReasoning: true,
    backend: { type: 'tiktoken', encoding: 'o200k_base' },
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    vocabSize: 201088,
    hiddenReasoning: true,
    backend: { type: 'tiktoken', encoding: 'o200k_base' },
  },
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    vocabSize: 201088,
    hiddenReasoning: true,
    backend: { type: 'tiktoken', encoding: 'o200k_base' },
  },
  // 'gpt-5.5' and 'gpt-5.5-pro' were removed 2026-08-15 alongside their price
  // rows in prompt/builder.ts. OpenAI publishes neither id any longer: a raw
  // grep of developers.openai.com/api/docs/pricing and .../docs/models returns
  // ZERO hits for "gpt-5.5" in any spelling, against 17 for "gpt-5.6". Keeping
  // a tokenizer entry for a model the Prompt Architect can no longer price would
  // put the two rosters back out of step, which model-roster.test.ts exists to
  // catch. Checked by grepping the fetched HTML, not by asking a summariser —
  // that route invented GPT-5.5 rows twice in one afternoon.

  // Открытые модели — @huggingface/transformers (lazy-load)
  // Synapse's local base model is Gemma 4 E2B — id/name/repo must all agree;
  // previously the repo string pointed at the E4B tokenizer instead.
  'gemma-4-e2b': {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B (local)',
    vocabSize: 262144,
    backend: { type: 'transformers', repo: 'google/gemma-4-E2B-it', vocabSize: 262144 },
  },
  // DeepSeek V4 split into Pro/Flash 2026-07-09 (was one 'deepseek-v4' entry
  // reusing the Pro repo for both) — each now has its own verified-fetchable
  // (HTTP 200, anonymous) HF repo with its own tokenizer.json.
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    vocabSize: 129280,
    hiddenReasoning: true,
    backend: { type: 'transformers', repo: 'deepseek-ai/DeepSeek-V4-Pro', vocabSize: 129280 },
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    vocabSize: 129280,
    hiddenReasoning: true,
    backend: { type: 'transformers', repo: 'deepseek-ai/DeepSeek-V4-Flash', vocabSize: 129280 },
  },
  // Qwen 3.7-Max is closed-weight — Alibaba has never published its tokenizer.
  // This repo ('Qwen/Qwen3-32B', an OPEN Qwen model) is the nearest available
  // open vocab, not 3.7-Max's real tokenizer — closedWeightApprox forces
  // tokenize() to report this honestly as 'approx' rather than 'native'.
  'qwen-3.7-max': {
    id: 'qwen-3.7-max',
    name: 'Qwen 3.7-Max',
    vocabSize: 151936,
    closedWeightApprox: true,
    backend: { type: 'transformers', repo: 'Qwen/Qwen3-32B', vocabSize: 151936 },
  },
  // Context widened 128,000 → 262,144 2026-07-09 per Mistral's own model card
  // (docs.mistral.ai/models/model-cards/mistral-large-3-25-12, states "256k").
  // Note: the repo's raw params.json max_position_embeddings is 294,912 (a
  // RoPE-scaling architectural ceiling) — 262,144 is the officially documented
  // served context, which is what's shipped here.
  'mistral-large-3': {
    id: 'mistral-large-3',
    name: 'Mistral Large 3',
    vocabSize: 131072,
    backend: {
      type: 'transformers',
      repo: 'mistralai/Mistral-Large-3-675B-Instruct-2512',
      vocabSize: 131072,
    },
  },
  // Meta gates meta-llama/Llama-4-Scout-17B-16E-Instruct (HTTP 401 anonymous).
  // 'unsloth/...' is a community mirror of the same weights/tokenizer with the
  // gate removed — verified HTTP 200 anonymous 2026-07-09. Same tokenizer file,
  // not a different model, so this stays 'native' (no closedWeightApprox).
  'llama-4-scout': {
    id: 'llama-4-scout',
    name: 'Llama 4 Scout',
    vocabSize: 202048,
    backend: {
      type: 'transformers',
      repo: 'unsloth/Llama-4-Scout-17B-16E-Instruct',
      vocabSize: 202048,
    },
  },
  // zai-org/GLM-5.2's own tokenizer.json is anonymously fetchable (verified
  // HTTP 200, 2026-07-09) — this is the model's real tokenizer, not a
  // same-family stand-in, so it's legitimately 'native' tier if it loads.
  'glm-5.2': {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    vocabSize: 154880,
    backend: { type: 'transformers', repo: 'zai-org/GLM-5.2', vocabSize: 154880 },
  },

  // Закрытые модели — API через бэкенд
  // Fable 5 and Opus 4.8 used to carry verifiedViaSameFamilyModel because
  // map_model_name substituted "claude-sonnet-4-6-20250514" server-side. That
  // disclosure was wrong in substance: Anthropic documents that 4.7-and-later
  // models use a NEWER tokenizer producing ~30% more tokens for the same text
  // (platform.claude.com/docs/en/build-with-claude/token-counting, which names
  // Fable 5 explicitly). So it was not a same-family stand-in — it was the
  // wrong tokenizer generation, reporting counts about a third low under a
  // "Verified" badge. The substitution is now removed from main.py: these ids
  // go to Anthropic as-is, so a returned count is genuinely exact, and a
  // failure degrades to the api backend's honest 'approx' path.
  'claude-fable-5': {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    vocabSize: 150000,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'anthropic' },
  },
  'claude-opus-4.8': {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    vocabSize: 150000,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'anthropic' },
  },
  // Added here 2026-08-10 to close a roster drift, not to add a feature. This
  // row and 'gemini-3.6-flash' below already existed in prompt/builder.ts but
  // not in this file, and the Prompt Architect looks models up HERE:
  // `tokenize(text, model.id as ModelId)` — the cast lied, `getModelInfo`
  // returned undefined, and reading `.backend` off it threw. The UI caught the
  // throw, kept the PREVIOUS model's token counts, and let the $derived cost
  // recompute the NEW model's price against them — so selecting the most
  // expensive model in the roster showed a wrong dollar figure next to an
  // error banner. `hiddenReasoning` was silently false for both, which also
  // suppressed the billed-but-invisible-tokens warning on exactly the models
  // where it costs the most. See tests/unit/model-roster.test.ts.
  'claude-opus-5': {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    vocabSize: 150000,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'anthropic' },
  },
  // Anthropic ids from the 4.6 generation on are dateless — 'claude-sonnet-5',
  // not 'claude-sonnet-5-<date>'. They are sent to the count-tokens endpoint
  // verbatim; nothing is substituted, so a returned count is exact or there is
  // no count at all.
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    vocabSize: 150000,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'anthropic' },
  },
  // id corrected 2026-08-09: 'claude-haiku' is not a real Anthropic model id
  // and would 400 on every call. The current generation is Haiku 4.5; there is
  // no Haiku 5. $1.00/$5.00 per 1M, 200K ctx.
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    vocabSize: 150000,
    backend: { type: 'api', provider: 'anthropic' },
  },
  // id corrected 2026-08-09: this row used to be keyed 'gemini-3.5-pro', an id
  // Google has never shipped — it is absent from both the pricing and models
  // pages, and Google's own Pro page still shows "coming soon". The July pass
  // renamed the visible label but left the fictional id in place, which
  // main.py then had to paper over with a "closest available" substitution.
  // Both are gone: the id is now the model that actually answers.
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    vocabSize: 262144,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'google' },
  },
  // Repriced 2026-07-09 — was $0.15/$0.60 (~10x under live), now $1.50/$9.00,
  // verified via OpenRouter (google/gemini-3.5-flash raw pricing object).
  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    vocabSize: 262144,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'google' },
  },
  // The second half of the roster drift described on 'claude-opus-5' above.
  // Source: ai.google.dev/gemini-api/docs/pricing, added to builder.ts
  // 2026-08-09 (at a price that was double the real one — see that row).
  'gemini-3.6-flash': {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    vocabSize: 262144,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'google' },
  },
  // Added 2026-08-15, in the same commit as its builder.ts row — the roster
  // join test in tests/unit/model-roster.test.ts fails the build if these two
  // files disagree, which is how the earlier drift was caught and how this
  // entry came to exist at the same moment as its price.
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    vocabSize: 262144,
    hiddenReasoning: true,
    backend: { type: 'api', provider: 'google' },
  },
};

/** Ordered list of model IDs for UI selectors */
export const MODEL_LIST: ModelId[] = Object.keys(MODELS) as ModelId[];

export function getModelInfo(model: ModelId): ModelInfo {
  return MODELS[model];
}

const HUES = [155, 220, 40, 300, 0, 280]; // Green, Blue, Yellow, Magenta, Red, Purple

// HUES is a non-empty constant palette, so `index % HUES.length` is always in
// range; the assertion documents that guarantee, which noUncheckedIndexedAccess
// cannot infer (it widens every indexed read to `T | undefined`).
function hueFor(index: number): number {
  return HUES[index % HUES.length] as number;
}

/**
 * Hard cap on tokenizer textarea input length. Without one, pasting ~4MB of
 * text (reproduced in live persona testing) hangs tiktoken/transformers
 * encoding on the main thread with zero user feedback. Mirrors
 * MAX_BLOCK_CONTENT_LENGTH in lib/prompt/builder.ts — same order of
 * magnitude, same rationale, kept as a separate constant since the two
 * features are independent and may need to diverge later.
 */
export const MAX_TOKENIZER_INPUT_LENGTH = 100_000;

// ─────────────────────────────────────────────────────────────────────────
// CHAT-TEMPLATE OVERHEAD — per-backend accounting
// ─────────────────────────────────────────────────────────────────────────

// OpenAI's documented ChatML token-accounting rule ("How to count tokens with
// tiktoken", OpenAI Cookbook / the historical gpt-3.5-turbo-0301 message
// format note): every message costs 3 tokens of role/wrapper overhead, and a
// further 3 tokens prime the reply once all messages have been added. js-tiktoken
// has no chat template of its own, so this documented formula is the honest
// substitute — it is NOT a live measurement against the real encoder.
// Exported so lib/prompt/builder.ts's multi-block chatWrappingOverhead can
// reuse the exact same documented numbers instead of duplicating them.
export const OPENAI_CHATML_TOKENS_PER_MESSAGE = 3;
export const OPENAI_CHATML_REPLY_PRIMING_TOKENS = 3;

// We have no client-side way to observe Anthropic's or Google's exact
// message-wrapper tokens (no local tokenizer, no chat template to apply).
// This is a conservative, order-of-magnitude placeholder — always surfaced
// as `estimated` in the UI, never presented as an exact or documented count.
// Exported for the same reason as the two constants above.
export const API_CHAT_OVERHEAD_ESTIMATE_TOKENS = 5;

function tiktokenChatOverhead(totalTokens: number): ChatOverhead {
  const overhead = OPENAI_CHATML_TOKENS_PER_MESSAGE + OPENAI_CHATML_REPLY_PRIMING_TOKENS;
  return { wrappedTotal: totalTokens + overhead, overhead, exactness: 'documented' };
}

function estimatedChatOverhead(totalTokens: number): ChatOverhead {
  return {
    wrappedTotal: totalTokens + API_CHAT_OVERHEAD_ESTIMATE_TOKENS,
    overhead: API_CHAT_OVERHEAD_ESTIMATE_TOKENS,
    exactness: 'estimated',
  };
}

/** Encoder cache. Encoding is sync once built; *building* one now awaits the
 *  rank table's dynamic import, so the getter is async. Only these two tables
 *  are reachable: `o200k_base` for every model whose backend declares it, and
 *  `cl100k_base` for the approximation fallback — which must stay cl100k so
 *  the numbers it reports do not silently change basis. */
const encoderCache: Record<string, Tiktoken> = {};
/** In-flight loads, so N models tokenizing at once fetch the table once. */
const encoderLoads: Record<string, Promise<Tiktoken>> = {};

function getTiktokenEncoder(encoding: string): Promise<Tiktoken> {
  const cached = encoderCache[encoding];
  if (cached) return Promise.resolve(cached);

  const inFlight = encoderLoads[encoding];
  if (inFlight) return inFlight;

  // The specifiers are literal on purpose: a template string would leave the
  // bundler unable to see the target and it would stop code-splitting them.
  const load = (
    encoding === 'o200k_base'
      ? import('js-tiktoken/ranks/o200k_base')
      : import('js-tiktoken/ranks/cl100k_base')
  ).then((mod) => {
    const enc = new Tiktoken(mod.default);
    encoderCache[encoding] = enc;
    delete encoderLoads[encoding];
    return enc;
  });

  encoderLoads[encoding] = load;
  return load;
}

async function tokenizeWithTiktoken(
  text: string,
  info: ModelInfo,
  opts?: TokenizeOptions
): Promise<TokenResult> {
  const backend = info.backend as { type: 'tiktoken'; encoding: string };
  // Clock starts AFTER the rank table is in hand. `latencyMs` is reported to
  // the user as tokenization speed; folding a one-off 1 MB download into it
  // would make the first run look ~100x slower than the tokenizer is.
  const encoder = await getTiktokenEncoder(backend.encoding);
  const startTime = performance.now();

  const tokenIds = encoder.encode(text);
  const timeMs = performance.now() - startTime;

  const tokens: Token[] = [];
  const textEncoder = new TextEncoder();

  for (const [i, id] of tokenIds.entries()) {
    const tokenText = encoder.decode([id]);
    const partial = isPartialByteSequence(tokenText);
    // When partial, re-encoding the U+FFFD-laden decode would produce bytes
    // that are NOT this token's real bytes — leave `bytes` empty rather than
    // fabricate a byte value for callers to render as fact.
    const rawBytes = partial ? [] : Array.from(textEncoder.encode(tokenText));

    tokens.push({
      id,
      text: tokenText,
      hue: hueFor(i),
      bytes: rawBytes,
      partial,
    });
  }

  const totalTokens = tokenIds.length;
  const totalChars = countCodepoints(text);
  const density = totalTokens > 0 ? totalChars / totalTokens : 0;
  const latencyMs = timeMs;

  opts?.onStatus?.('ready', info.id);

  return {
    tokens,
    totalTokens,
    totalChars,
    density,
    latencyMs,
    accuracy: 'native',
    chatOverhead: opts?.includeChatTemplate ? tiktokenChatOverhead(totalTokens) : undefined,
  };
}

async function tokenizeWithTiktokenFallback(
  text: string,
  info: ModelInfo,
  opts?: TokenizeOptions,
  reason: FallbackReason = 'network'
): Promise<TokenResult> {
  // Prefer the worker. This path returns `tokens: []` below — it needs a count
  // and nothing else — while building the cl100k table costs ~1 MB of parsing
  // that lands as a single long task between FCP and TTI, i.e. straight into
  // Total Blocking Time. The Prompt Architect reaches here on every load (its
  // default model has an `api` backend and the inference server is not
  // deployed), which is what put 730 ms of TBT on that page.
  //
  // Every worker failure falls through to the in-thread path below, so the
  // count always arrives; the worst case is exactly the behaviour this replaced.
  let totalTokens: number | null = null;
  let timeMs = 0;

  const offThread = countOffThread(text);
  if (offThread) {
    try {
      const result = await offThread;
      totalTokens = result.count;
      timeMs = result.ms;
    } catch {
      totalTokens = null; // fall through
    }
  }

  if (totalTokens === null) {
    // Same rule as the native path: time the encode, not the table download.
    const encoder = await getTiktokenEncoder('cl100k_base');
    const startTime = performance.now();

    totalTokens = encoder.encode(text).length;
    timeMs = performance.now() - startTime;
  }

  const totalChars = countCodepoints(text);
  const density = totalTokens > 0 ? totalChars / totalTokens : 0;
  const latencyMs = timeMs;

  opts?.onStatus?.('error', info.id);

  return {
    tokens: [],
    totalTokens,
    totalChars,
    density,
    latencyMs,
    accuracy: 'approx',
    fallbackReason: reason,
    // The base count itself is already an approximation here (real backend
    // unreachable) — an on-top ChatML overhead would be a guess about a
    // guess, so this stays in the 'estimated' tier rather than 'documented'.
    chatOverhead: opts?.includeChatTemplate ? estimatedChatOverhead(totalTokens) : undefined,
  };
}

// Кэш загруженных токенизаторов (загружается 1 раз на модель)
const hfCache: Record<string, PreTrainedTokenizer> = {};

async function tokenizeWithTransformers(
  text: string,
  info: ModelInfo,
  opts?: TokenizeOptions
): Promise<TokenResult> {
  const { repo } = info.backend as { type: 'transformers'; repo: string };

  try {
    // Lazy-load: загружаем только при первом использовании
    if (!hfCache[repo]) {
      opts?.onStatus?.('loading', info.id);
      const { AutoTokenizer } = await import('@huggingface/transformers');
      hfCache[repo] = await AutoTokenizer.from_pretrained(repo);
    }

    const tokenizer = hfCache[repo];
    const startTime = performance.now();

    // encode возвращает token IDs
    const encoded = tokenizer.encode(text);
    const tokenIds: number[] = Array.from(encoded);

    // Декодируем каждый токен для визуализации
    const textEncoder = new TextEncoder();
    const tokens: Token[] = tokenIds.map((id, i) => {
      const tokenText = tokenizer.decode([id]);
      const partial = isPartialByteSequence(tokenText);
      // Same honesty rule as the tiktoken path: a partial multibyte decode
      // means re-encoding it would fabricate bytes, not report real ones.
      const rawBytes = partial ? [] : Array.from(textEncoder.encode(tokenText));
      return { id, text: tokenText, hue: hueFor(i), bytes: rawBytes, partial };
    });

    const timeMs = performance.now() - startTime;
    const totalTokens = tokenIds.length;
    const totalChars = countCodepoints(text);
    const density = totalTokens > 0 ? totalChars / totalTokens : 0;
    const latencyMs = timeMs;

    opts?.onStatus?.('ready', info.id);

    let chatOverhead: ChatOverhead | undefined;
    if (opts?.includeChatTemplate) {
      try {
        // Real chat template for THIS model, via the loaded tokenizer — the
        // wrapped token ids are the actual, byte-exact overhead. tokenize:true +
        // return_tensor:false + return_dict:false yields a plain number[] (see
        // @huggingface/transformers' ApplyChatTemplateReturn/BatchEncodingArrayItem
        // types), matching the plain `tokenIds` shape used above.
        const wrappedIds = tokenizer.apply_chat_template([{ role: 'user', content: text }], {
          tokenize: true,
          add_generation_prompt: true,
          return_tensor: false,
          return_dict: false,
        }) as number[];
        const wrappedTotal = wrappedIds.length;
        chatOverhead = { wrappedTotal, overhead: wrappedTotal - totalTokens, exactness: 'native' };
      } catch {
        // This tokenizer has no chat_template configured (or the Jinja template
        // failed to render) — fall back to the same conservative estimate used
        // for API-only backends, clearly marked as such rather than as native.
        chatOverhead = estimatedChatOverhead(totalTokens);
      }
    }

    return {
      tokens,
      totalTokens,
      totalChars,
      density,
      latencyMs,
      accuracy: 'native',
      chatOverhead,
    };
  } catch (err) {
    // Caller explicitly cancelled (superseded by a newer request) — propagate,
    // do not spend work computing a fallback result nobody will read. Mirrors
    // the api backend's cancellation handling below.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    // A bad/renamed/offline HF repo (from_pretrained 404s or the network is
    // down) would otherwise hard-break the whole tool with no recovery —
    // degrade to the same honest tiktoken approximation the api backend uses
    // on fetch failure, so the UI shows a 🟡 approx result instead of dying.
    console.warn(
      `[tokenizer] transformers backend failed to load "${repo}" for ${info.id}, falling back to tiktoken approximation`,
      err
    );
    return tokenizeWithTiktokenFallback(text, info, opts, 'onDeviceLoad');
  }
}

async function tokenizeWithAPI(
  text: string,
  info: ModelInfo,
  opts?: TokenizeOptions
): Promise<TokenResult> {
  opts?.onStatus?.('fetching', info.id);
  const startTime = performance.now();

  try {
    // Запрос к нашему FastAPI бэкенду
    const res = await fetch(`${SYNAPSE_API_BASE}/api/tokenize/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: info.id, text }),
      signal: opts?.signal,
    });

    if (!res.ok) {
      // The fetch reached our FastAPI backend and got a real HTTP response —
      // the backend is up. A non-OK status here is almost always the
      // upstream provider (Anthropic/Google) rejecting the request (billing,
      // rate limit, bad request) being surfaced through our proxy, NOT our
      // backend being offline. Tag the fallback 'provider' so the UI doesn't
      // lie about backend availability.
      console.warn(
        `[tokenizer] API tokenize failed for ${info.id} (HTTP ${res.status}), falling back to tiktoken`
      );
      return tokenizeWithTiktokenFallback(text, info, opts, 'provider');
    }

    const data: unknown = await res.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { totalTokens?: unknown }).totalTokens !== 'number'
    ) {
      // Same reasoning as above — the backend answered, just not usefully.
      console.warn(
        `[tokenizer] API tokenize returned an invalid payload for ${info.id}, falling back to tiktoken`
      );
      return tokenizeWithTiktokenFallback(text, info, opts, 'provider');
    }

    const totalTokens = (data as { totalTokens: number }).totalTokens;
    const timeMs = performance.now() - startTime;
    const latencyMs = timeMs;

    opts?.onStatus?.('ready', info.id);

    const totalChars = countCodepoints(text);

    return {
      tokens: [], // API не возвращает разбивку по токенам
      totalTokens,
      totalChars,
      density: totalTokens > 0 ? totalChars / totalTokens : 0,
      latencyMs,
      accuracy: 'verified',
      // Even though the base count is provider-verified, the message-wrapper
      // overhead itself is never observed client-side for Claude/Gemini — see
      // API_CHAT_OVERHEAD_ESTIMATE_TOKENS above. Always 'estimated', never 'native'.
      chatOverhead: opts?.includeChatTemplate ? estimatedChatOverhead(totalTokens) : undefined,
    };
  } catch (err) {
    // Caller explicitly cancelled (superseded by a newer request) — propagate,
    // do not spend work computing a fallback result nobody will read.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    console.warn(`[tokenizer] API backend not ready for ${info.id}, using tiktoken approximation`);
    return tokenizeWithTiktokenFallback(text, info, opts);
  }
}

export async function tokenize(
  text: string,
  model: ModelId,
  opts?: TokenizeOptions
): Promise<TokenResult> {
  if (!text) {
    return {
      tokens: [],
      totalTokens: 0,
      totalChars: 0,
      density: 0,
      latencyMs: 0,
      accuracy: 'native',
    };
  }

  const info = getModelInfo(model);

  switch (info.backend.type) {
    case 'tiktoken':
      return tokenizeWithTiktoken(text, info, opts);

    case 'transformers': {
      const result = await tokenizeWithTransformers(text, info, opts);
      // Closed-weight models (see ModelInfo.closedWeightApprox) use a
      // nearest-open-vocab substitute repo, not their own tokenizer. Only
      // downgrade the SUCCESS path ('native') — a genuine load failure is
      // already honestly 'approx' with its own fallbackReason and shouldn't
      // be overwritten.
      if (info.closedWeightApprox && result.accuracy === 'native') {
        return { ...result, accuracy: 'approx', fallbackReason: 'closedWeight' };
      }
      return result;
    }

    case 'api':
      // An unrequested count never reaches for the network — see `allowNetwork`.
      // The number it returns is still real, just produced locally and labelled
      // as an approximation rather than silently presented as a provider count.
      if (opts?.allowNetwork === false) {
        return tokenizeWithTiktokenFallback(text, info, opts, 'notRequested');
      }
      return tokenizeWithAPI(text, info, opts);

    default:
      return tokenizeWithTiktokenFallback(text, info, opts);
  }
}
