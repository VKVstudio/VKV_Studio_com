# VKVstudio

A bilingual (EN/RU) engineering portfolio with three working LLM tools and a self-hosted,
fine-tuned assistant behind it. Live at **[vkvstudio.com](https://vkvstudio.com)**.

Not a template and not a demo repo: everything described below is deployed and answering
requests. Where something is half-built, this file says so rather than leaving you to find out.

---

## What is actually interesting here

**A fine-tune that runs on a $0-idle box.** Synapse is Gemma 4 E2B (~2B parameters) fine-tuned
with QLoRA and served as a Q8_0 GGUF through `llama.cpp` on a four-core ARM server with **no
GPU**. It is grounded on a small hand-curated fact corpus (`inference/rag/`) so a 2B model can
answer questions about this studio without inventing them. The cost of that honesty is latency:
a first answer takes 30–45 seconds, and the repo does not pretend otherwise.

**Three Lab tools, three different execution models.**
[Tokenizer Profiler](https://vkvstudio.com/en/lab/tokenizer/) picks one of three backends per
model — WASM `tiktoken`, a local Hugging Face vocabulary, or a provider API for models that
publish no client-side tokenizer — and labels an approximation as approximate.
[Prompt Architect](https://vkvstudio.com/en/lab/prompt/) composes role blocks and prices them
against a maintained table of real provider rates.
[Embedding Explorer](https://vkvstudio.com/en/lab/embeddings/) embeds server-side with
EmbeddingGemma-300M, reduces with UMAP, and renders the result in 3D.

**A frontend with no framework tax.** Astro 6 static output, Svelte 5 runes islands, vanilla CSS
on a design-token system, GSAP + Lenis for motion. No Tailwind, no component library.

**A build log that admits things.** [The journal](https://vkvstudio.com/en/log/) records the
decisions and the mistakes, including the retrain that fixed the wrong half of the problem and
the day the site published something it should not have.

---

## Running it

Frontend only — this is enough to see the whole site. There is no build-time dependency on the
backend; with it unreachable the assistant falls back to a scripted mock and everything else
works normally.

```bash
pnpm install
pnpm run dev            # http://localhost:4173
```

The inference server, if you want the real assistant:

```bash
cd inference
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py    # http://localhost:8000
```

You will need a GGUF model file locally — model weights are not in this repository. Everything
in `inference/config.py` is overridable by `SYNAPSE_*` environment variables; see `.env.example`.

```bash
pnpm exec vitest        # 165 frontend tests
cd inference && python -m pytest tests    # 177 backend tests
```

---

## Honest state

- **Speech-to-text does not work.** Synapse speaks (Google Chirp 3 HD) and cannot listen. The
  mic button is present and says so when pressed.
- **No image or file input.** The base model is multimodal; this deployment does not wire it up.
- **The assistant is a 2B model still being fine-tuned** and can be confidently wrong. Its
  factual claims about anything outside the grounding corpus should be treated as unverified.
- **The training and evaluation harness under `training/` is included for reading, not running:**
  the dataset it was fine-tuned on is not published.

---

## Layout

| Path                                | What is in it                                                       |
| ----------------------------------- | ------------------------------------------------------------------- |
| `src/lib/tokenizer/`                | The three-backend tokenizer engine                                  |
| `src/lib/prompt/builder.ts`         | Model price/context table and the cost arithmetic                   |
| `src/components/ui/Synapse*.svelte` | The assistant: orb → terminal, SSE streaming, audio                 |
| `inference/main.py`                 | FastAPI app — chat, voice, embeddings, token counting, auth, limits |
| `inference/rag/`                    | The grounding corpus and retriever                                  |
| `training/`                         | QLoRA fine-tune and evaluation harness                              |
| `tests/`, `inference/tests/`        | 342 unit tests                                                      |

---

## Licence

There is deliberately none. This is a portfolio: it is published to be read and evaluated, not
to be redeployed as someone else's site. An OSI licence would grant exactly that, so its absence
is the accurate state rather than an oversight — you retain no rights to reuse this code.

Questions, or something here that looks wrong: **hello@vkvstudio.com**.
