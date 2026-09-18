/**
 * Per-tool FAQ for the three Lab pages — visible copy AND structured data.
 *
 * Why this exists: the Lab pages ask good questions and answer them nowhere a
 * machine can pair up. The Copilot panel ships "Why is the count for Claude
 * approximate?" as a button whose answer only arrives from a live model call,
 * and the matching explanation sits in a separate tips list further down. A
 * crawler sees a question and, elsewhere, an unattached sentence.
 *
 * It is also a thinness fix. Server-rendered text before this: tokenizer 361
 * words, prompt 453, embeddings 250 — the last one is that low because its
 * island is `client:only`, so what a crawler gets is a spinner. These pages are
 * the reason someone would link to this site at all.
 *
 * Same shape as `src/data/faq.ts`, same rule: one source for the rendered
 * section and the JSON-LD, so the two cannot drift apart.
 *
 * Every number here is checked against the code, not remembered:
 * `minCacheTokens` / `cacheWriteMultiplier` / `cacheReadMultiplier` /
 * `batchDiscount` come from `src/lib/prompt/builder.ts`; the embedding widths
 * from the Matryoshka control in `src/components/lab/embedding/`.
 */
import type { FaqItem } from '@/data/faq';
import type { LabTool } from '@/lib/lab-copilot-content';

export interface LabFaqSet {
  heading: { en: string; ru: string };
  items: FaqItem[];
}

export const LAB_FAQ: Record<LabTool, LabFaqSet> = {
  tokenizer: {
    heading: { en: 'Tokens, in plain terms', ru: 'Про токены, простыми словами' },
    items: [
      {
        q: {
          en: 'What is a token, and how many tokens is 1,000 words?',
          ru: 'Что такое токен и сколько токенов в 1000 слов?',
        },
        a: {
          en: 'A token is the unit a model actually reads: usually a common word, a fragment of a rarer one, or a piece of punctuation. For ordinary English prose, 1,000 words lands around 1,300–1,500 tokens — but that ratio is a rule of thumb, not a rule, and it falls apart on code, tables and non-English text. The point of this tool is that you can stop estimating and see the real split for your own text.',
          ru: 'Токен — это единица, которую модель на самом деле читает: обычно частое слово, кусок слова поредче или знак препинания. Для обычной английской прозы 1000 слов — это примерно 1300–1500 токенов, но это прикидка, а не правило: на коде, таблицах и неанглийском тексте она разваливается. Смысл инструмента в том, чтобы перестать прикидывать и увидеть реальную разбивку своего текста.',
        },
      },
      {
        q: {
          en: 'Why do Russian text and source code cost more tokens than English?',
          ru: 'Почему русский текст и код стоят дороже в токенах, чем английский?',
        },
        a: {
          en: 'Because the vocabularies were built mostly on English. A common English word is often a single token; the same word in Russian is frequently cut into three or four pieces, and source code splits on nearly every symbol. In practice Cyrillic and code run about 2–3× the token count of the same amount of English prose. That is a real line on the bill, not a curiosity — paste both and the difference shows up immediately.',
          ru: 'Потому что словари собирались в основном на английском. Частое английское слово — часто один токен; то же слово по-русски нередко режется на три-четыре куска, а код разваливается почти по каждому символу. На практике кириллица и код обходятся примерно в 2–3 раза дороже того же объёма английской прозы. Это реальная строка в счёте, а не курьёз: вставьте оба текста и увидите разницу сразу.',
        },
      },
      {
        q: {
          en: 'Why is the Claude count marked approximate instead of exact?',
          ru: 'Почему счёт для Claude помечен как приблизительный, а не точный?',
        },
        a: {
          en: "Anthropic and Google do not publish their tokenizers, so nothing running on your device can reproduce their split. When the inference server is reachable, this tool asks the provider's own API for the real number and marks it Verified. When it is not, it falls back to a nearby open vocabulary and marks the result Approximate. That is deliberate: a number presented as exact when it is not is worse than no number at all.",
          ru: 'Anthropic и Google не публикуют свои токенайзеры, поэтому воспроизвести их разбивку у вас на устройстве нечем. Когда сервер инференса доступен, инструмент запрашивает точное число у API самого провайдера и помечает его как Verified. Когда недоступен — берёт ближайший открытый словарь и честно ставит Approximate. Это осознанно: число, выданное за точное, когда оно не точное, хуже, чем отсутствие числа.',
        },
      },
      {
        q: {
          en: "What are hidden reasoning tokens, and why can't this tool count them?",
          ru: 'Что такое скрытые токены рассуждений и почему их здесь нельзя посчитать?',
        },
        a: {
          en: 'Several models generate an internal chain of thought before answering. You are billed for it as output, and you never see it, so the real cost of a call can be several times the visible reply. This tool cannot count those tokens for one honest reason: the number does not exist until the model actually generates an answer — it is not derivable from the text you typed. So the models that do this carry a warning instead of an invented figure.',
          ru: 'Некоторые модели перед ответом порождают внутреннюю цепочку рассуждений. Она выставляется вам в счёт как вывод, но вы её не видите — поэтому реальная стоимость запроса бывает в несколько раз выше видимого ответа. Посчитать эти токены инструмент не может по честной причине: их число не существует, пока модель реально не сгенерирует ответ, из введённого текста оно не выводится. Поэтому у таких моделей стоит предупреждение, а не выдуманная цифра.',
        },
      },
    ],
  },

  prompt: {
    heading: { en: 'Prompt cost, in plain terms', ru: 'Про стоимость промпта, простыми словами' },
    items: [
      {
        q: {
          en: 'How do you work out what a prompt will cost before you send it?',
          ru: 'Как понять, во сколько обойдётся промпт, ещё до отправки?',
        },
        a: {
          en: "Cost is token count times the model's input price, plus the reply at its output price — but the money hides in the details. This tool counts the blocks you wrote, the chat-template scaffolding the API wraps around them, and the tokens your tool definitions occupy, then prices all of it against the current rate for every model in the picker. Tool definitions in particular are billable input that people routinely forget they are paying for on every single call.",
          ru: 'Стоимость — это количество токенов на цену ввода модели плюс ответ по цене вывода, но деньги прячутся в деталях. Инструмент считает написанные вами блоки, обвязку чат-шаблона, которую API добавляет вокруг них, и токены самих определений инструментов, а потом оценивает всё это по текущей цене каждой модели в списке. Определения инструментов — это как раз тот оплачиваемый ввод, про который регулярно забывают, а платят за него в каждом запросе.',
        },
      },
      {
        q: {
          en: 'What is prompt caching, and when does it actually save money?',
          ru: 'Что такое кеширование промпта и когда оно реально экономит?',
        },
        a: {
          en: 'A provider can hold the unchanging front of your prompt — a long system prompt, a fixed document — and charge much less to read it again. The catch is a floor, and it is per model, not per provider: most models here cache from 1,024 tokens, but Claude Opus, Fable and Haiku will not cache a block under 4,096 at all — while Claude Sonnet 5, confusingly, sits with the 1,024 group. Writing the cache also costs more than a plain read (1.25× at Anthropic) before it starts paying back at 0.10×. A block under the floor earns nothing, so this tool shows zero savings for it rather than a discount that will never arrive.',
          ru: 'Провайдер может удерживать неизменную голову вашего промпта — длинный системный промпт, фиксированный документ — и брать за повторное чтение сильно меньше. Загвоздка в пороге, и он у каждой модели свой, а не у провайдера: большинство моделей здесь кешируют от 1024 токенов, но Claude Opus, Fable и Haiku не возьмут в кеш блок меньше 4096 — а Claude Sonnet 5, что сбивает с толку, сидит в группе с 1024. Запись в кеш к тому же дороже обычного чтения (1,25× у Anthropic) и только потом начинает отбиваться по 0,10×. Блок ниже порога не даёт ничего, поэтому инструмент показывает для него нулевую экономию, а не скидку, которой не будет.',
        },
      },
      {
        q: {
          en: 'Does the order of the blocks in a prompt matter?',
          ru: 'Влияет ли порядок блоков в промпте?',
        },
        a: {
          en: 'For caching it is the difference between paying once and paying on every call: whatever you want cached has to sit at the front and stay byte-identical between requests. Put a timestamp or a user name above your long system prompt and the cache misses every single time. Roles matter for a separate reason — system for standing rules, context for retrieved material, user for the actual request — because models weight them differently, and burying an instruction inside pasted context is the usual way it gets ignored.',
          ru: 'Для кеширования это разница между «заплатить один раз» и «платить каждый запрос»: всё, что вы хотите закешировать, должно стоять в начале и оставаться байт в байт тем же между запросами. Поставьте отметку времени или имя пользователя выше длинного системного промпта — и кеш будет промахиваться каждый раз. Роли важны по другой причине: system — для постоянных правил, context — для найденного материала, user — для самого запроса, потому что модели взвешивают их по-разному, а инструкция, закопанная внутрь вставленного контекста, — это типовой способ сделать так, чтобы её проигнорировали.',
        },
      },
      {
        q: {
          en: 'What is the Batch API, and when is it worth using?',
          ru: 'Что такое Batch API и когда его стоит использовать?',
        },
        a: {
          en: 'The same model at roughly half price, in exchange for giving up the immediate answer: you submit a batch and collect the results later. Anthropic and OpenAI both document a 50% discount, so this tool applies it for them; Google documents none, so nothing is applied there rather than a guessed figure. It is worth it for anything with no human waiting on the other end — evaluation runs, bulk classification, offline generation.',
          ru: 'Та же модель примерно за полцены в обмен на отказ от немедленного ответа: вы отправляете пакет и забираете результаты позже. Anthropic и OpenAI документируют скидку 50%, поэтому инструмент её применяет; у Google такой скидки в документации нет, поэтому там не применяется ничего — вместо угаданной цифры. Выгодно везде, где на том конце никто не ждёт: прогоны оценки, массовая классификация, офлайн-генерация.',
        },
      },
    ],
  },

  embeddings: {
    heading: {
      en: 'Embeddings and RAG, in plain terms',
      ru: 'Про эмбеддинги и RAG, простыми словами',
    },
    items: [
      {
        q: {
          en: 'What is a text embedding?',
          ru: 'Что такое эмбеддинг текста?',
        },
        a: {
          en: "A list of numbers that stands in for meaning. A model reads a piece of text and returns a fixed-length vector — 768 numbers here, from Google EmbeddingGemma running on this studio's own server — placed so that texts meaning similar things land close together and unrelated ones land far apart. That is the whole trick behind search by meaning: comparison stops being a language problem and becomes arithmetic.",
          ru: 'Это список чисел, который стоит вместо смысла. Модель читает кусок текста и возвращает вектор фиксированной длины — здесь 768 чисел, от Google EmbeddingGemma на собственном сервере студии, — расположенный так, что тексты про похожее оказываются рядом, а не связанные между собой — далеко. В этом весь фокус поиска по смыслу: сравнение перестаёт быть языковой задачей и становится арифметикой.',
        },
      },
      {
        q: {
          en: 'What is RAG, and what does this tool actually show of it?',
          ru: 'Что такое RAG и что именно этот инструмент из него показывает?',
        },
        a: {
          en: 'Retrieval-augmented generation: instead of hoping a model memorised a fact, you look the fact up and hand it to the model along with the question. This tool exposes every stage of the retrieval half — how text is cut into chunks, how those chunks are embedded, how a query is matched against them, and how the shortlist is reordered before anything is passed on. Those stages are where RAG systems actually fail in production, and in most products they are completely invisible.',
          ru: 'Retrieval-augmented generation: вместо надежды на то, что модель запомнила факт, вы этот факт находите и отдаёте модели вместе с вопросом. Инструмент показывает каждый этап поисковой половины — как текст режется на фрагменты, как фрагменты превращаются в векторы, как с ними сопоставляется запрос и как короткий список переупорядочивается перед тем, как что-то передать дальше. Именно на этих этапах RAG-системы и ломаются в проде, и в большинстве продуктов они полностью не видны.',
        },
      },
      {
        q: {
          en: 'Why combine vector search with old-fashioned keyword search?',
          ru: 'Зачем совмещать векторный поиск с обычным поиском по словам?',
        },
        a: {
          en: 'Because they fail differently. Vector search understands that "car" and "automobile" are one idea, but it drifts on exact strings — a part number, a surname, an error code. BM25 keyword scoring nails those and is helpless with synonyms. Fusing the two rankings — Reciprocal Rank Fusion here — keeps each one\'s strength, which is why serious retrieval systems rarely rely on either alone.',
          ru: 'Потому что ломаются они по-разному. Векторный поиск понимает, что «машина» и «автомобиль» — одно и то же, но плывёт на точных строках: артикул, фамилия, код ошибки. Лексический BM25 берёт их уверенно и беспомощен с синонимами. Слияние двух ранжирований — здесь Reciprocal Rank Fusion — сохраняет сильную сторону каждого, поэтому серьёзные поисковые системы редко полагаются на что-то одно.',
        },
      },
      {
        q: {
          en: 'What is Matryoshka truncation, and what does it cost you?',
          ru: 'Что такое усечение «матрёшки» и чем за него платишь?',
        },
        a: {
          en: "EmbeddingGemma is trained so that the front of the vector carries most of the meaning. That lets you cut 768 numbers down to 512, 256 or 128 and still search usefully — a quarter of the storage, and noticeably faster comparisons. What you pay is precision, along a curve you can watch here instead of reading about: the same search re-runs at each width, so you can see where quality actually starts to break for your data rather than trusting a benchmark run on someone else's.",
          ru: 'EmbeddingGemma обучена так, что начало вектора несёт большую часть смысла. Поэтому 768 чисел можно урезать до 512, 256 или 128 и всё ещё искать осмысленно — вчетверо меньше хранилища и заметно более быстрые сравнения. Платите вы точностью, и кривую этой платы здесь можно увидеть, а не прочитать о ней: один и тот же поиск переигрывается на каждой ширине, так что видно, где качество реально начинает сыпаться на ваших данных, а не на чужом бенчмарке.',
        },
      },
    ],
  },
};
