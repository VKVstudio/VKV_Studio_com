/**
 * The service ladder — ONE source for every place a service is described:
 * the homepage teaser, the /services/ index, the four rung pages, and their
 * Service/Offer JSON-LD. Same rule as faq.ts: one array, so the visible copy
 * and the structured data cannot drift apart.
 *
 * The ladder is ordered by buyer risk, not by our pride: a stranger's first
 * transaction is €900, never €7,500. Each rung names the next one. Retainers
 * are deliberately scoped lists ("N prompts, monthly report, X fixes"), never
 * open-ended availability — the studio is one engineer, and every commitment
 * on these pages must survive that fact. Response promise is within one
 * business day in EU hours, nowhere 24/7.
 *
 * Two content rules are load-bearing and enforced by tests/unit/services-data.test.ts:
 * no payment method we cannot actually accept (Armenian sole proprietors have
 * no Stripe), and no registry numbers anywhere (see the privacy incident note
 * in .system/). Prices: EVERYTHING in EUR (owner decision 2026-08-21, backed
 * by .system/pricing_research_2026-08-21.md) — the funnel is EU/UK, invoices
 * carry no VAT (EU/UK clients self-account for it under the reverse charge,
 * other jurisdictions owe none), and settlement stays flexible (EUR/USD/GBP
 * in ENGAGEMENT_TERMS). Pricing law from the same research: an entry diagnostic
 * must cost LESS than one month of the retainer it feeds (market ratio
 * 0.3–0.6×) — a credit may never exceed one monthly invoice. Test-enforced.
 * A credit is always scoped to the FULL retainer, never a lite/thin tier —
 * a buyer skimming a page next to a cheaper lite price is exactly the
 * ambiguity the pricing-law test guards against (2026-08-22 fix).
 *
 * Price notation: full figures (€7,500) in price-label positions (priceLine,
 * retainer.price, seo.title/description) — k-notation (€15–25k) is allowed
 * only inside flowing prose ranges, never as the headline number. RU strings
 * use a space as the thousands separator (€7 500, the RU typographic norm);
 * EN keeps the comma (€7,500). Test-enforced.
 */

export interface Bilingual {
  en: string;
  ru: string;
}

export interface ServiceRetainer {
  title: Bilingual;
  /** Human price line, e.g. "from €2,000/mo" — retainers are EUR by design. */
  price: Bilingual;
  includes: Bilingual[];
  /** The safety-valve line: cancel terms, slots, response window. */
  terms: Bilingual;
  /**
   * Optional thin tier — a one-sentence downsell (e.g. monitoring without
   * implementation). Rendered as a quiet line under the retainer, never as
   * a competing card: the priced offer above stays the story.
   */
  lite?: Bilingual;
  /**
   * Machine-readable monthly price for the retainer's own Offer node in
   * serviceNode() — only set on retainers worth exposing to structured data
   * (the three AI-track retainers). priceCurrency is always EUR.
   */
  priceJsonLd?: { minPrice: string; maxPrice?: string };
}

export interface ServiceRung {
  /** Stable id, also the URL segment under /services/. */
  id: 'geo-audit' | 'rag-pilot' | 'on-prem-ai' | 'websites';
  /** Mono eyebrow in the site's pseudo-comment idiom, e.g. "// 01 · audit". */
  monoLabel: string;
  title: Bilingual;
  /** Result-first headline for cards and the page hero. */
  outcome: Bilingual;
  /** Human price line for cards, e.g. "€900 · fixed". */
  priceLine: Bilingual;
  timeframe: Bilingual;
  /** One-sentence card copy for the homepage teaser. */
  teaser: Bilingual;
  /** What the buyer receives, itemized — the thing that makes fixed price believable. */
  deliverables: Bilingual[];
  /** Honest exclusions — scope law, stated up front. */
  notIncluded: Bilingual[];
  /** Risk reversal on the rung, if any. */
  riskReversal?: Bilingual;
  /** i18n key for the risk-block heading. Defaults to 'services.guaranteeLabel'
   *  ("The guarantee"); a rung whose riskReversal is a de-risking path rather
   *  than an actual guarantee MUST override it — the swarm audit 2026-09-06
   *  caught on-prem selling a paid assessment under the word "guarantee". */
  riskLabelKey?: string;
  /** The recurring engine attached to this rung. */
  retainer?: ServiceRetainer;
  /** Case-study page that proves this rung, if one exists. */
  caseHref?: string;
  caseLabel?: Bilingual;
  seo: { title: Bilingual; description: Bilingual };
  /**
   * Machine-readable price for the Offer/PriceSpecification node: a fixed
   * `price` for packages, or a `minPrice` (with optional `maxPrice`) for
   * "from €X" and ranged rungs. Discriminated on `price` so serviceNode()
   * can branch without a runtime fallback.
   */
  priceJsonLd:
    | { price: string; currency: 'EUR' }
    | { minPrice: string; maxPrice?: string; currency: 'EUR' };
}

export const SERVICES: ServiceRung[] = [
  {
    id: 'geo-audit',
    monoLabel: '// 01 · audit',
    title: {
      en: 'AI Search Visibility Audit',
      ru: 'Аудит видимости в ИИ-поиске',
    },
    outcome: {
      en: 'Find out how ChatGPT, Perplexity and Google AI describe your business — and what to fix first.',
      ru: 'Узнайте, как ChatGPT, Perplexity и Google AI описывают ваш бизнес — и что исправлять первым.',
    },
    priceLine: {
      en: '€900 · fixed, no sales call needed',
      ru: '€900 · фикс, без обязательного созвона',
    },
    timeframe: {
      en: '5–10 business days',
      ru: '5–10 рабочих дней',
    },
    teaser: {
      en: 'Where AI answers cite you — and where they name your competitor instead. Fixed scope, written report, priced like a diagnostic, not a retainer.',
      ru: 'Где ИИ-ответы ссылаются на вас — а где называют вашего конкурента. Фиксированный скоуп, письменный отчёт, цена диагностики, а не ретейнера.',
    },
    deliverables: [
      {
        en: '20 buyer-intent prompts tested across five engines: ChatGPT, Perplexity, Google AI Overviews & AI Mode, Copilot, Gemini',
        ru: '20 коммерческих запросов, проверенных в пяти движках: ChatGPT, Perplexity, Google AI Overviews и AI Mode, Copilot, Gemini',
      },
      {
        en: 'AI Share-of-Voice baseline: how often engines cite you versus two or three named competitors',
        ru: 'Стартовый замер AI Share-of-Voice: как часто движки цитируют вас на фоне двух-трёх конкретных конкурентов',
      },
      {
        en: 'Entity audit: how AI actually describes your company today, and the gaps that make it guess',
        ru: 'Аудит сущности: как ИИ на самом деле описывает вашу компанию сегодня и какие пробелы заставляют его угадывать',
      },
      {
        en: 'Technical layer: JSON-LD schema depth, llms.txt, AI-crawler access — robots rules and rendering',
        ru: 'Технический слой: глубина JSON-LD-разметки, llms.txt, доступ ИИ-краулеров — правила robots и рендеринг',
      },
      {
        en: 'A prioritized fix roadmap: what to change first, what each change buys you, what to skip',
        ru: 'Дорожная карта исправлений по приоритету: что менять первым, что даёт каждое изменение, что можно пропустить',
      },
      {
        en: 'A written report your team can act on the same day — plus a written Q&A round: every question answered within one business day',
        ru: 'Письменный отчёт, с которым ваша команда может работать в тот же день, — плюс раунд вопросов и ответов, тоже письменный: на каждый отвечаю в течение одного рабочего дня',
      },
    ],
    notIncluded: [
      {
        en: 'Content writing and citation building — ongoing editorial work, out of scope for a fixed one-off audit',
        ru: 'Написание контента и наращивание цитируемости — постоянная редакционная работа, вне рамок фиксированного разового аудита',
      },
      {
        en: 'Ranking guarantees in AI answers. Nobody can honestly sell those — the methodology page explains what is measurable and what is not',
        ru: 'Гарантии позиций в ИИ-ответах. Честно продать их не может никто — на странице методологии объяснено, что измеримо, а что нет',
      },
    ],
    riskReversal: {
      en: "If the report doesn't show you anything you can act on, you don't pay. That's the whole guarantee.",
      ru: 'Если отчёт не покажет вам ничего, с чем можно работать, — вы не платите. Это вся гарантия.',
    },
    retainer: {
      title: {
        en: 'AI Visibility Retainer',
        ru: 'Ретейнер ИИ-видимости',
      },
      price: {
        en: 'from €2,000/month',
        ru: 'от €2 000/месяц',
      },
      includes: [
        {
          en: 'Your prompt set tracked monthly across all five engines — tooling included in the price',
          ru: 'Ваш набор запросов отслеживается ежемесячно во всех пяти движках — инструменты включены в цену',
        },
        {
          en: 'A monthly delta report in plain language: what moved, why, what we do next',
          ru: 'Ежемесячный отчёт об изменениях простым языком: что сдвинулось, почему, что делаем дальше',
        },
        {
          en: 'Two to three fixes implemented each month — schema, llms.txt, content restructuring. Implemented, not recommended',
          ru: 'Каждый месяц — два-три внедрённых исправления: разметка, llms.txt, перестройка контента. Именно внедрённых, а не рекомендованных',
        },
        {
          en: 'Start the full retainer within 30 days of your audit and the €900 you already paid comes straight off your first invoice — the audit ends up costing you nothing.',
          ru: 'Начнёте полный ретейнер в течение 30 дней после аудита — уплаченные €900 просто вычитаются из первого счёта. Аудит в итоге не стоит вам ничего.',
        },
      ],
      terms: {
        en: 'Cancel any month, no lock-in. Response within one business day, EU hours. Limited slots — one engineer does the work, and that engineer is the one you talk to.',
        ru: 'Отмена в любой месяц — никаких долгосрочных обязательств. Ответ в течение одного рабочего дня, в часы ЕС. Число мест ограничено: работу делает один инженер, и именно с ним вы разговариваете.',
      },
      lite: {
        en: 'Only need the numbers? Monitoring alone — the same five-engine tracking and monthly delta report, without implementation — is €600/month (the audit credit applies to the full retainer only).',
        ru: 'Нужны только цифры? Мониторинг без внедрения — то же отслеживание в пяти движках и ежемесячный отчёт об изменениях — €600/месяц (зачёт аудита действует только на полном ретейнере).',
      },
      priceJsonLd: { minPrice: '2000' },
    },
    seo: {
      title: {
        en: 'GEO Audit — AI Search Visibility, €900 Fixed | VKVstudio',
        ru: 'GEO-аудит — видимость в ИИ-поиске, €900 фикс | VKVstudio',
      },
      description: {
        en: 'Fixed-scope AI visibility audit: 20 prompts across five engines, share-of-voice, schema and llms.txt review, prioritised fixes. €900, 5–10 business days, no call.',
        ru: 'Аудит ИИ-видимости: 20 запросов в пяти движках, share-of-voice, разметка и llms.txt, исправления по приоритету. €900, 5–10 рабочих дней, без созвона.',
      },
    },
    priceJsonLd: { price: '900', currency: 'EUR' },
  },
  {
    id: 'rag-pilot',
    monoLabel: '// 02 · pilot',
    title: {
      en: 'Private AI Assistant — Pilot',
      ru: 'Приватный ИИ-ассистент — пилот',
    },
    outcome: {
      en: 'Your technical documentation, answering questions in seconds — on infrastructure you control.',
      ru: 'Ваша техническая документация отвечает на вопросы за секунды — на инфраструктуре, которую контролируете вы.',
    },
    priceLine: {
      en: '€4,500 · fixed pilot',
      ru: '€4 500 · фиксированный пилот',
    },
    timeframe: {
      en: '3 weeks',
      ru: '3 недели',
    },
    teaser: {
      en: 'A working RAG assistant over your technical documentation, with an acceptance test we write together before any money moves. Built for engineering, manufacturing, lab and construction teams; production follows only if the pilot passes.',
      ru: 'Работающий RAG-ассистент по вашей технической документации, с приёмочным тестом, который мы пишем вместе до первого платежа. Сделан для инженерных, производственных, лабораторных и строительных команд; продакшн — только если пилот проходит тест.',
    },
    deliverables: [
      {
        en: 'One document source, up to roughly 500 pages — technical documentation, engineering manuals, standards and internal regulations, product catalogues and specifications',
        ru: 'Один источник документов, примерно до 500 страниц — техническая документация, инженерные руководства, стандарты и внутренние регламенты, каталоги продукции и спецификации',
      },
      {
        en: 'An acceptance test written together before work starts: the questions it must answer correctly to count as done',
        ru: 'Приёмочный тест, который мы пишем вместе до начала работ: вопросы, на которые система обязана отвечать верно, чтобы считаться готовой',
      },
      {
        en: 'Deployed on your server or a dedicated EU machine you own — never a shared platform',
        ru: 'Разворачивается на вашем сервере или на выделенной машине в ЕС, которой владеете вы, — никогда на общей платформе',
      },
      {
        en: 'Hybrid option: sensitive workloads stay local, heavy reasoning goes to an EU-hosted API — the dominant production architecture, not a compromise',
        ru: 'Гибридный вариант: чувствительные данные остаются локально, тяжёлые рассуждения уходят в EU-hosted API — это доминирующая продакшн-архитектура, а не компромисс',
      },
      {
        en: 'Full documentation, a runbook, and a handover pack — your IT team can take the system over at any point',
        ru: 'Полная документация, runbook и handover-пакет — ваша IT-команда может забрать систему в любой момент',
      },
      {
        en: 'A precise production quote after the pilot — typical production rollouts run €10–20k, and you will know yours before committing',
        ru: 'Точная смета продакшна после пилота — типичный продакшн-запуск стоит €10–20k, и вы узнаете свою цифру прежде, чем принимать решение',
      },
    ],
    notIncluded: [
      {
        en: 'Multi-source connectors, SSO, and role-based access — that is production-phase work, quoted after the pilot',
        ru: 'Коннекторы к нескольким источникам, SSO и разграничение доступа — это работа продакшн-фазы, оценивается после пилота',
      },
      {
        en: 'Frontier-model reasoning claims. For narrow-domain tasks a fine-tuned small model matches what you used to pay GPT-4 prices for; when a task truly needs a frontier model, I will tell you so',
        ru: 'Обещания рассуждать на уровне frontier-моделей. Для узких доменных задач дообученная малая модель даёт то, за что вы раньше платили по ценам GPT-4; когда задаче правда нужна frontier-модель — я так и скажу',
      },
      {
        en: 'Document sets built around people — HR files, patient or client records, case files, support histories. Those carry personal data, and that changes what has to be agreed before anyone opens anything; the fixed pilot is scoped to corpora that carry none. Bring one of those and we start with a separate conversation, not with scope',
        ru: 'Наборы документов, собранные вокруг людей, — кадровые дела, карты пациентов или клиентов, материалы по делам, переписка поддержки. В них есть персональные данные, а это меняет то, о чём нужно договориться до того, как кто-либо что-либо откроет; фиксированный пилот рассчитан на корпуса, где таких данных нет. Если корпус именно такой — начинаем с отдельного разговора, а не со скоупа',
      },
    ],
    riskReversal: {
      en: "The acceptance test is the guarantee: if the pilot fails the test we defined together, you don't pay the final milestone.",
      ru: 'Приёмочный тест и есть гарантия: если пилот не проходит тест, который мы определили вместе, — финальный платёж вы не вносите.',
    },
    retainer: {
      title: {
        en: 'Care Plan',
        ru: 'План сопровождения',
      },
      price: {
        en: 'from €1,500/month',
        ru: 'от €1 500/месяц',
      },
      includes: [
        {
          en: 'Monitoring, index updates as your documents change, and model updates as better open weights ship',
          ru: 'Мониторинг, обновление индекса при изменении ваших документов и обновление модели по мере выхода более сильных открытых весов',
        },
        {
          en: 'Prompt and retrieval tuning driven by real usage, not guesses',
          ru: 'Настройка промптов и поиска по реальному использованию, а не по догадкам',
        },
        {
          en: 'Response within one business day in EU hours',
          ru: 'Ответ в течение одного рабочего дня в часы ЕС',
        },
      ],
      terms: {
        en: 'Cancel any month. The handover pack means leaving is always possible — which is exactly why staying is safe.',
        ru: 'Отмена в любой месяц. Handover-пакет означает, что уйти можно всегда, — именно поэтому оставаться безопасно.',
      },
      priceJsonLd: { minPrice: '1500' },
    },
    caseHref: '/cases/synapse/',
    caseLabel: {
      en: 'Proof: Synapse — my own fine-tuned model with live RAG, self-hosted on a 4-core ARM box. Click the brain on the homepage and talk to it.',
      ru: 'Доказательство: Synapse — моя собственная дообученная модель с живым RAG, развёрнутая на моей же 4-ядерной ARM-машине. Кликните по мозгу на главной и поговорите с ним.',
    },
    seo: {
      title: {
        en: 'Private RAG Assistant Pilot — €4,500 Fixed | VKVstudio',
        ru: 'Пилот приватного RAG-ассистента — €4 500 фикс | VKVstudio',
      },
      description: {
        en: 'A fixed-price RAG pilot on your technical documentation, standards and catalogues: acceptance test agreed up front, deployed on infrastructure you own. Three weeks, €4,500, production quoted after.',
        ru: 'RAG-пилот по фиксированной цене: ваша техническая документация, стандарты и каталоги, приёмочный тест заранее, развёртывание на вашей инфраструктуре. Три недели, €4 500, смета продакшна после.',
      },
    },
    priceJsonLd: { price: '4500', currency: 'EUR' },
  },
  {
    id: 'on-prem-ai',
    monoLabel: '// 03 · sovereign',
    title: {
      en: 'Self-Hosted AI Deployment',
      ru: 'Self-hosted AI — развёртывание',
    },
    outcome: {
      en: 'AI your data never leaves. Your hardware or a dedicated EU server — you own every part of it.',
      ru: 'ИИ, который ваши данные не покидают. Ваше железо или выделенный сервер в ЕС — вы владеете каждой частью.',
    },
    priceLine: {
      en: 'from €7,500 · starter deployment',
      ru: 'от €7 500 · стартовое развёртывание',
    },
    timeframe: {
      en: '4–6 weeks',
      ru: '4–6 недель',
    },
    teaser: {
      en: 'A fine-tuned open model running where your compliance team can point at it. Starter from €7,500; typical full deployments run €15–25k.',
      ru: 'Дообученная открытая модель работает там, куда может показать пальцем ваш комплаенс. Стартовое развёртывание — от €7 500; типичное полное — €15–25k.',
    },
    deliverables: [
      {
        en: 'One open model (Gemma or Mistral class), fine-tuned to your domain voice and format where the task needs it',
        ru: 'Одна открытая модель (класса Gemma или Mistral), дообученная под язык вашей предметной области и нужный формат там, где этого требует задача',
      },
      {
        en: 'A single node — your rack, or a dedicated EU server (Hetzner, OVH) registered to you, not to me',
        ru: 'Один узел — ваша стойка или выделенный сервер в ЕС (Hetzner, OVH), оформленный на вас, а не на меня',
      },
      {
        en: 'Retrieval over one document source, with the same acceptance-test discipline as the pilot',
        ru: 'Поиск по одному источнику документов, с той же дисциплиной приёмочного теста, что и в пилоте',
      },
      {
        en: 'A standard open stack — llama.cpp or vLLM, pgvector or Qdrant — nothing proprietary between you and your system',
        ru: 'Стандартный открытый стек — llama.cpp или vLLM, pgvector или Qdrant — ничего проприетарного между вами и вашей системой',
      },
      {
        en: 'Deployment without your production data: the build, the fine-tune and the acceptance test run on synthetic or anonymised material you prepare, and your own staff load the live corpus following the runbook',
        ru: 'Развёртывание без ваших реальных данных: сборка, дообучение и приёмочный тест идут на синтетическом или обезличенном материале, который готовите вы, а живой корпус загружают ваши сотрудники по runbook',
      },
      {
        en: 'Full documentation, runbook, handover pack, and a 30-day post-launch warranty',
        ru: 'Полная документация, runbook, handover-пакет и 30-дневная гарантия после запуска',
      },
      {
        en: 'Compliance paperwork support: DPIA input and a processing-records template for your DPO',
        ru: 'Поддержка комплаенс-документов: материалы для DPIA и шаблон реестра обработки для вашего DPO',
      },
    ],
    notIncluded: [
      {
        en: 'GPU clusters and enterprise scale — that is an agency engagement, and I will say so instead of pretending otherwise',
        ru: 'GPU-кластеры и enterprise-масштаб — это работа для агентства, и я скажу это прямо, а не буду притворяться',
      },
      {
        en: 'A 24/7 SLA. You get a response within one business day in EU hours, in writing — a promise one engineer can actually keep',
        ru: 'SLA 24/7. Вы получаете ответ в течение одного рабочего дня в часы ЕС, письменно — обещание, которое один инженер способен сдержать',
      },
      {
        en: 'Standing access to the running system. Deployment ends with your team holding every key and me holding none. If you want me operating or diagnosing the live system afterwards, that is the support agreement — scoped, priced and papered on its own, because access is exactly where the paperwork question starts',
        ru: 'Постоянный доступ к работающей системе. Развёртывание заканчивается тем, что все ключи у вашей команды, а у меня нет ни одного. Если дальше вы хотите, чтобы живую систему эксплуатировал или диагностировал я, — это договор сопровождения: отдельный скоуп, отдельная цена, отдельные документы, потому что вопрос о документах начинается ровно с доступа',
      },
    ],
    riskReversal: {
      en: 'Not sure self-hosting is even right for you? Start with the €1,400 readiness assessment — one week, a written architecture recommendation, credited in full against a deployment. If an EU-hosted API with a DPA genuinely covers your case, the assessment says exactly that, and you’ve just saved €6,100.',
      ru: 'Не уверены, что self-hosting вам вообще нужен? Начните с оценки готовности за €1 400 — неделя, письменная архитектурная рекомендация, сумма полностью засчитывается в стоимость развёртывания. Если ваш случай честно закрывается EU-hosted API с DPA — в оценке будет написано именно это, и вы сэкономите €6 100.',
    },
    riskLabelKey: 'services.deriskLabel',
    retainer: {
      title: {
        en: 'Sovereign Care',
        ru: 'Сопровождение Sovereign',
      },
      price: {
        en: '€1,500–3,000/month',
        ru: '€1 500–3 000/месяц',
      },
      includes: [
        {
          en: 'Monitoring, security patches, and model updates as the open-weights frontier moves',
          ru: 'Мониторинг, патчи безопасности и обновление модели по мере выхода более сильных открытых моделей',
        },
        {
          en: 'Compliance upkeep: the paperwork stays current as regulation shifts',
          ru: 'Поддержание комплаенса: документы остаются актуальными по мере изменения регулирования',
        },
        {
          en: 'Response within one business day in EU hours',
          ru: 'Ответ в течение одного рабочего дня в часы ЕС',
        },
      ],
      terms: {
        en: 'Cancel any month. Everything is documented and standard — your IT team can take over whenever you choose. That is the design, not a concession. Where support needs access to your live system, that access is named, time-boxed, logged on your side and revoked when the ticket closes — agreed in writing before it exists, never as a standing key.',
        ru: 'Отмена в любой месяц. Всё задокументировано и стандартно — ваша IT-команда может принять систему, когда вы решите. Это архитектурный замысел, а не уступка. Там, где сопровождению нужен доступ к живой системе, доступ именной, ограниченный по времени, журналируется на вашей стороне и отзывается по закрытии заявки — оформляется письменно до того, как появится, и никогда не выдаётся «навсегда».',
      },
      priceJsonLd: { minPrice: '1500', maxPrice: '3000' },
    },
    caseHref: '/cases/synapse/',
    caseLabel: {
      en: 'Proof: the assistant on this site is my own fine-tuned Gemma with live retrieval, self-hosted on a 4-core ARM server. The architecture is published.',
      ru: 'Доказательство: ассистент на этом сайте — моя дообученная Gemma с живым поиском, развёрнутая на моём же 4-ядерном ARM-сервере. Архитектура опубликована.',
    },
    seo: {
      title: {
        en: 'Self-Hosted AI — On-Premise LLM for EU Companies | VKVstudio',
        ru: 'Self-hosted AI для компаний ЕС — on-premise LLM | VKVstudio',
      },
      description: {
        en: 'A fine-tuned open model on your hardware or a dedicated EU server — the weights, the machine and the data are yours. From €7,500, maintenance from €1,500/month.',
        ru: 'Дообученная открытая модель на вашем железе или сервере в ЕС — веса, машина и данные принадлежат вам. От €7 500, сопровождение от €1 500/мес.',
      },
    },
    priceJsonLd: { minPrice: '7500', currency: 'EUR' },
  },
  {
    id: 'websites',
    monoLabel: '// 04 · web',
    title: {
      en: 'Websites That Score 100',
      ru: 'Сайты на 100 баллов',
    },
    outcome: {
      en: 'A marketing site that loads instantly and proves it — the way this one does: 100 without its video hero, 99 with it.',
      ru: 'Маркетинговый сайт, который загружается мгновенно — и может это доказать. Как этот: 100 без видео-героя, 99 с ним.',
    },
    priceLine: {
      en: '€3,500–5,500 · fixed scope',
      ru: '€3 500–5 500 · фиксированный скоуп',
    },
    timeframe: {
      en: '3–5 weeks',
      ru: '3–5 недель',
    },
    teaser: {
      en: 'Astro, vanilla CSS, and a Lighthouse target written into the contract — measured on your real content, not a demo template.',
      ru: 'Astro, чистый CSS и целевой балл Lighthouse, прописанный в договоре, — замер на вашем реальном контенте, а не на демо-шаблоне.',
    },
    deliverables: [
      {
        en: 'Design and build on Astro with vanilla CSS — no framework tax, nothing shipped that your visitor does not need',
        ru: 'Дизайн и сборка на Astro с чистым CSS — без балласта фреймворков: посетитель не грузит ничего, что ему не нужно',
      },
      {
        en: 'A Lighthouse performance target written into the contract, measured on the real site with real content',
        ru: 'Целевой балл Lighthouse, прописанный в договоре и измеренный на реальном сайте с реальным контентом',
      },
      {
        en: "AI-search ready by default: schema, llms.txt, AI-crawler access — the €900 audit's checklist is built in, not sold separately",
        ru: 'Готовность к ИИ-поиску по умолчанию: разметка, llms.txt, доступ ИИ-краулеров — чек-лист аудита за €900 встроен, а не продаётся отдельно',
      },
      {
        en: 'Bilingual builds available — this site runs a full EN/RU build with hreflang done right',
        ru: 'Возможна двуязычная сборка — этот сайт полностью живёт в EN/RU с корректным hreflang',
      },
      {
        en: 'Built from the content and exports you hand over — a new build or a redesign needs no login to your production admin, your CRM or your user database, so nothing about your users or customers ever reaches my machine',
        ru: 'Сборка идёт по контенту и выгрузкам, которые передаёте вы, — новому сайту и редизайну не нужны ни доступ в админку продакшена, ни CRM, ни база пользователей, так что ничего о ваших пользователях и клиентах ко мне не попадает',
      },
      {
        en: 'You own the repository and everything in it on final payment',
        ru: 'Репозиторий и всё, что в нём, — ваше с момента финального платежа',
      },
    ],
    notIncluded: [
      {
        en: 'Ongoing content production and brand identity from scratch — bring your own designer, or I will recommend one',
        ru: 'Регулярное производство контента и айдентика с нуля — приходите со своим дизайнером, или я порекомендую проверенного',
      },
      {
        en: 'Web applications and SaaS builds — real products deserve their own scoping conversation, not a website package',
        ru: 'Веб-приложения и SaaS — настоящие продукты заслуживают отдельного разговора об объёме работ, а не пакета для сайта',
      },
      {
        en: 'Carrying a live user base across — accounts, orders, submitted-form history, a production CMS with real profiles. That is a migration rather than a build, and it starts with a written agreement on who touches that data and how, before the scope conversation; it is quoted separately',
        ru: 'Перенос живой базы пользователей — учётные записи, заказы, история отправленных форм, продовая CMS с реальными профилями. Это уже миграция, а не сборка: она начинается с письменной договорённости о том, кто и как касается этих данных, ещё до разговора о скоупе, и оценивается отдельно',
      },
    ],
    riskReversal: {
      en: "The performance target is contractual: if the homepage doesn't hit the agreed Lighthouse score at launch, the final milestone waits until it does.",
      ru: 'Целевой балл — часть договора: если главная не набирает согласованный балл Lighthouse на запуске, финальный платёж ждёт, пока не наберёт.',
    },
    caseHref: '/cases/vkvstudio-site/',
    caseLabel: {
      en: 'Proof: how this exact site was built — the full case study.',
      ru: 'Доказательство: как построен этот самый сайт — полный разбор.',
    },
    seo: {
      title: {
        en: 'Astro Websites With a Lighthouse Clause | VKVstudio',
        ru: 'Сайты на Astro с Lighthouse в договоре | VKVstudio',
      },
      description: {
        en: 'Marketing sites on Astro: a Lighthouse target written into the contract, measured on your real content. €3,500–5,500, 3–5 weeks. AI-search readiness built in.',
        ru: 'Сайты на Astro: целевой балл Lighthouse прописан в договоре и измеряется на вашем контенте. €3 500–5 500, 3–5 недель. Готовность к ИИ-поиску встроена.',
      },
    },
    priceJsonLd: { minPrice: '3500', maxPrice: '5500', currency: 'EUR' },
  },
];

/** Thrown by getRung() — a missing id is a data bug, not a runtime maybe. */
export class ServiceRungNotFoundError extends Error {
  constructor(id: string) {
    super(`services.ts: no rung with id "${id}"`);
    this.name = 'ServiceRungNotFoundError';
  }
}

/**
 * The single lookup every rung page uses instead of
 * `SERVICES.find(...)!` — the non-null assertion hid a silent `undefined`
 * if a rung id ever drifted from the page folder name. This throws with a
 * named, greppable error instead.
 */
export function getRung(id: ServiceRung['id']): ServiceRung {
  const rung = SERVICES.find((r) => r.id === id);
  if (!rung) throw new ServiceRungNotFoundError(id);
  return rung;
}

/**
 * The proof strip — four verifiable facts, each carrying its own qualifier so
 * no claim outruns what we can show. Rendered on the homepage teaser and the
 * services index.
 */
export interface ProofItem {
  /**
   * Bilingual because not every number reads the same in both languages:
   * "1.3M" is English notation, and Russian writes the same quantity as
   * "1,3 млн" — a decimal comma and a different magnitude suffix. Shipping
   * one string put "1.3M" in the proof strip while the RU timeline said
   * "1,3 млн" two screens below, on the same page. Scores like 99/100 are
   * language-neutral and simply repeat the same string in both.
   */
  value: Bilingual;
  label: Bilingual;
  qualifier: Bilingual;
}

export const PROOF_STRIP: ProofItem[] = [
  {
    value: { en: '99/100', ru: '99/100' },
    label: { en: 'Lighthouse performance', ru: 'производительность Lighthouse' },
    qualifier: {
      en: 'this homepage, desktop, with the video hero; without it — 100',
      ru: 'эта главная, десктоп, с видео на первом экране; без видео — 100',
    },
  },
  {
    value: { en: '3/3', ru: '3/3' },
    label: {
      en: 'Lighthouse agentic browsing',
      ru: 'агентный просмотр в Lighthouse',
    },
    qualifier: {
      en: "all three checks Google's agent audit runs — run it here yourself",
      ru: 'все три проверки агентного аудита Google — прогоните сами',
    },
  },
  {
    value: { en: '1.3M+', ru: '1,3 млн+' },
    label: {
      en: "units sold by a client's shop",
      ru: 'товаров продал магазин клиента',
    },
    qualifier: {
      en: 'Wildberries and Ozon — I built its product-photography system',
      ru: 'на Wildberries и Ozon — систему предметной съёмки для него построил я',
    },
  },
  {
    value: { en: 'self-hosted', ru: 'на своём железе' },
    label: { en: 'fine-tuned Gemma', ru: 'дообученная Gemma' },
    qualifier: {
      en: 'live on this site — click the brain and talk to it',
      ru: 'живёт на этом сайте — кликните по мозгу и поговорите с ним',
    },
  },
];

/**
 * How money and paper work — shared across every service page and the trust
 * page. Kept here so a payment-method change is one edit, and so the "no
 * unavailable payment providers" test has one place to look.
 */
export const ENGAGEMENT_TERMS: Bilingual[] = [
  {
    en: 'Fixed price, milestone payments — typically 30/40/30 — your prepayment never exceeds one milestone.',
    ru: 'Фиксированная цена, оплата по этапам — обычно 30/40/30 — ваша предоплата никогда не превышает стоимость одного этапа.',
  },
  {
    en: 'Payment by bank transfer against an invoice — the account details and the currency are on the invoice. Invoices carry no VAT: EU and UK clients self-account for it under the reverse charge, other jurisdictions owe none.',
    ru: 'Оплата банковским переводом по выставленному счёту — реквизиты и валюта указаны в нём. Счета выставляются без VAT: клиенты из ЕС и Великобритании самостоятельно учитывают его по механизму reverse charge, для остальных юрисдикций VAT не применяется.',
  },
  {
    en: 'Contract and NDA before any work beyond the audit — yours or mine, with an English-law option.',
    ru: 'Договор и NDA до начала любых работ, кроме аудита, — ваши или мои, с возможностью выбрать английское право.',
  },
  {
    en: 'Registered sole proprietorship in Armenia since February 2026. GMT+4: my afternoon is your morning, every working day.',
    ru: 'Зарегистрированный ИП в Армении с февраля 2026 года. GMT+4: моя вторая половина дня — ваше утро, каждый рабочий день.',
  },
];

/** Absolute URL helper for JSON-LD nodes. */
export const SITE_ORIGIN = 'https://vkvstudio.com';

export function serviceUrl(lang: 'en' | 'ru', id: ServiceRung['id']): string {
  return `${SITE_ORIGIN}/${lang}/services/${id}/`;
}
