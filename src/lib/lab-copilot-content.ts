/**
 * lab-copilot-content.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Curated, bilingual, static guidance for the Lab Copilot side panel — one entry
 * per Lab tool. This is the RELIABLE core of the panel: it explains the tool,
 * recommends concrete next actions, and gives accurate tips. Being hand-written
 * (not model-generated) means it works fully offline and can never confabulate
 * about tool mechanics — the LLM "Ask" box is reserved for open-ended questions.
 *
 * Keep facts here in sync with reality: embeddings + Synapse run server-side;
 * the Tokenizer + Prompt Architect run in the browser.
 */
import type { Lang } from '@/i18n/utils';

export type LabTool = 'tokenizer' | 'prompt' | 'embeddings';

export interface CopilotGuide {
  /** One–two sentence "what this tool is / does". */
  intro: string;
  /** Concrete "try this" next steps (rendered as numbered actions). */
  actions: string[];
  /** Accurate "good to know" tips referencing the tool's real mechanics. */
  tips: string[];
  /**
   * 2–3 static, curated questions rendered as clickable pills above the Ask
   * Synapse input — a click fills the input with the question and sends it.
   * Each one MUST be answerable from `intro` + `tips` (both are fed into the
   * model's context turn — see LabCopilot.svelte's ask()): the point is to
   * showcase a real tool feature, not set the model up to confabulate.
   */
  suggestions: string[];
}

export const COPILOT_CONTENT: Record<LabTool, Record<Lang, CopilotGuide>> = {
  tokenizer: {
    en: {
      intro:
        'See exactly how a model splits your text into tokens — and what that split costs in budget and context.',
      actions: [
        'Paste real text or a code snippet and watch the live token count.',
        'Switch the model to compare how GPT, Gemini, Claude, and Llama tokenize the same text.',
        'Toggle “as chat message” to reveal the hidden chat-template overhead you also pay for.',
      ],
      tips: [
        'A token is not a word: common words are one token, rare words and code split into several.',
        'Cyrillic and source code usually cost 2–3× more tokens than the same amount of English prose.',
        'Claude and Gemini counts come from a live call to the provider’s API (marked Verified) when the backend is reachable; if that call fails, the tool honestly falls back to an Approximate count instead of guessing silently.',
        'Some models can generate hidden reasoning tokens that get billed as output but never appear in the visible response — this tool can’t count them, since that number is only decided when the model actually generates a reply.',
      ],
      suggestions: [
        'Why is the count for Claude approximate?',
        'What are hidden reasoning tokens?',
        'Why does Cyrillic cost more tokens than English?',
      ],
    },
    ru: {
      intro:
        'Посмотри, как именно модель режет твой текст на токены — и во что это обходится по бюджету и контексту.',
      actions: [
        'Вставь реальный текст или кусок кода и смотри счётчик токенов в реальном времени.',
        'Переключай модель, чтобы сравнить, как GPT, Gemini, Claude и Llama токенизируют один текст.',
        'Включи режим «как чат-сообщение», чтобы увидеть скрытый overhead чат-шаблона, за который тоже платишь.',
      ],
      tips: [
        'Токен — не слово: частые слова — один токен, редкие и код разбиваются на несколько.',
        'Кириллица и код обычно стоят в 2–3 раза больше токенов, чем тот же объём английской прозы.',
        'Счётчик для Claude и Gemini берётся из живого вызова API провайдера (метка Verified), если бэкенд доступен; если вызов не удался, инструмент честно откатывается на приблизительный счёт (Approximate), а не молча гадает.',
        'Некоторые модели умеют генерировать скрытые reasoning-токены, которые биллятся как output, но никогда не попадают в видимый ответ — этот инструмент не может их посчитать: это число решается только в момент генерации.',
      ],
      suggestions: [
        'Почему счётчик для Claude приблизительный?',
        'Что такое скрытые reasoning-токены?',
        'Почему кириллица стоит больше токенов, чем английский?',
      ],
    },
  },
  prompt: {
    en: {
      intro:
        'Compose a prompt from role blocks and watch its token budget and cost update live across model providers.',
      actions: [
        'Add system / user / assistant blocks to give your prompt clear structure.',
        'Pick a target model to get real per-token input and output pricing.',
        'Export the result to your format — OpenAI, Anthropic, or plain text.',
      ],
      tips: [
        'Cost is input tokens plus the output you expect back — keep an eye on both, not just the prompt.',
        'A stable system block can be cached by some providers, cutting the cost of repeated calls.',
        'Providers only cache a prefix above a minimum size (about 1024 tokens for most models, 4096 for Claude Opus/Haiku) — a block marked cacheable below that floor is billed as fresh input every call, with zero real savings.',
        'The Batch API toggle applies the provider’s roughly −50% batch discount on top of any cache savings, in exchange for asynchronous (not real-time) processing — it only appears for models that document a batch discount.',
      ],
      suggestions: [
        'Why is my cached block not saving anything?',
        'What does the Batch API toggle do?',
        'Why do I have to pick an expected output length myself?',
      ],
    },
    ru: {
      intro:
        'Собери промпт из ролевых блоков и смотри, как бюджет токенов и стоимость обновляются в реальном времени по разным провайдерам.',
      actions: [
        'Добавляй блоки system / user / assistant, чтобы задать промпту чёткую структуру.',
        'Выбери целевую модель, чтобы увидеть реальную цену за входные и выходные токены.',
        'Экспортируй результат в свой формат — OpenAI, Anthropic или простой текст.',
      ],
      tips: [
        'Стоимость — это входные токены плюс ожидаемый ответ: следи за обоими, а не только за промптом.',
        'Стабильный system-блок некоторые провайдеры кэшируют, удешевляя повторные вызовы.',
        'Провайдеры кэшируют только префикс не меньше минимального размера (около 1024 токенов для большинства моделей, 4096 для Claude Opus/Haiku) — блок, помеченный кэшируемым, но ниже этого порога, биллится как свежий ввод при каждом вызове, без реальной экономии.',
        'Тумблер Batch API применяет скидку провайдера (примерно −50%) поверх любой экономии на кэше — в обмен на асинхронную (не real-time) обработку; он появляется только для моделей, у которых документирована batch-скидка.',
      ],
      suggestions: [
        'Почему мой кэшируемый блок ничего не экономит?',
        'Что делает тумблер Batch API?',
        'Почему нужно самому выбирать ожидаемую длину ответа?',
      ],
    },
  },
  embeddings: {
    en: {
      intro:
        'Turn text into vectors and explore meaning as an interactive 3D map you can search by similarity.',
      actions: [
        'Search the demo corpus by meaning, not keywords, and watch the nearest matches light up.',
        'Open the Chunking tab to see how a strategy cuts a document into pieces before embedding — a separate demo from Search, not a live input to it.',
        'Rerank the results to sharpen relevance beyond raw vector distance.',
      ],
      tips: [
        'Embeddings here are computed server-side by Google’s EmbeddingGemma, not in your browser.',
        'Points that sit close together mean similar things — distance is roughly semantic difference.',
        'MMR reranking is pure vector math — instant and deterministic, reordering the same dense candidates for relevance plus diversity. The LLM reranker (Retrieval tab) is a genuinely different, experimental mechanism: one real call to the self-hosted Gemma model, asked to judge relevance directly.',
        'RRF (Reciprocal Rank Fusion) fuses the dense and lexical rankings purely by rank position, not raw score — immune to one score’s scale dominating the blend, which is why it’s the safer 2026 default over min-max blending.',
      ],
      suggestions: [
        'What’s the difference between MMR and the LLM reranker?',
        'What is RRF?',
        'Why doesn’t the Chunking tab affect Search results?',
      ],
    },
    ru: {
      intro:
        'Преврати текст в векторы и исследуй смысл как интерактивную 3D-карту, по которой можно искать по близости.',
      actions: [
        'Ищи по демо-корпусу по смыслу, а не по ключевым словам, и смотри, как подсвечиваются ближайшие совпадения.',
        'Открой вкладку Chunking и посмотри, как стратегия режет документ на части перед эмбеддингом — это отдельная демка, а не то, что реально подаётся в поиск.',
        'Переранжируй результаты, чтобы уточнить релевантность сверх голой векторной близости.',
      ],
      tips: [
        'Эмбеддинги здесь считаются на сервере моделью Google EmbeddingGemma, а не в браузере.',
        'Точки рядом — близкие по смыслу; расстояние ≈ семантическая разница.',
        'MMR-переранжирование — чистая векторная математика: мгновенная и детерминированная, переупорядочивает те же dense-кандидаты по релевантности и разнообразию. LLM-реранкер (вкладка Retrieval) — принципиально другой, экспериментальный механизм: один реальный вызов self-hosted модели Gemma с просьбой напрямую оценить релевантность.',
        'RRF (Reciprocal Rank Fusion) сливает dense- и lexical-ранжирования по позиции в ранге, а не по сырому скору — это делает его нечувствительным к тому, что шкала одного скора задавит другую, поэтому это более безопасный дефолт 2026 года по сравнению с min-max блендом.',
      ],
      suggestions: [
        'В чём разница между MMR и LLM-реранкером?',
        'Что такое RRF?',
        'Почему вкладка Chunking не влияет на результаты поиска?',
      ],
    },
  },
};
