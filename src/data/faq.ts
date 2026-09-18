/**
 * The site's FAQ — ONE source for both the visible section and the JSON-LD.
 *
 * It used to live only inside BaseLayout's FAQPage markup, which meant the
 * answers existed for machines and not for people. Keeping one array here is
 * what stops the visible copy and the structured data drifting apart later.
 *
 * v2 (commercial pivot): the questions are now the ones a BUYER asks before
 * writing to a stranger abroad — process, money, ownership, continuity. The
 * old tech-demo questions were not deleted from the site: the tool questions
 * live in lab-faq.ts on the Lab pages, and the Synapse architecture story
 * lives in /cases/synapse/. Same content rules as services.ts (test-enforced
 * there, reviewed by hand here): no "Stripe", no registry numbers, no 24/7.
 */

export interface FaqItem {
  q: { en: string; ru: string };
  a: { en: string; ru: string };
}

export const FAQ: FaqItem[] = [
  {
    q: {
      en: 'How do we start?',
      ru: 'С чего начинается работа?',
    },
    a: {
      en: 'Two doors. If you want a low-risk first step, order the €900 AI-visibility audit — fixed scope, no call required, delivered in 5–10 business days. If your project is bigger, use the contact page: four short questions, and you get a written reply from the engineer within one business day — with an optional 30-minute call slot if you prefer talking. For everything beyond the audit, a signed contract and NDA come before any work does; the audit needs neither, since it reads only public sources.',
      ru: 'Две двери. Хотите первый шаг с минимальным риском — закажите аудит ИИ-видимости за €900: фиксированный скоуп, без созвона, готов за 5–10 рабочих дней. Если проект крупнее — страница контакта: четыре коротких вопроса, и вы получаете письменный ответ инженера в течение одного рабочего дня; а если удобнее голосом — 30-минутный созвон по желанию. Для всего, что крупнее аудита, договор и NDA подписываются до начала работ; самому аудиту они не нужны — он опирается только на публичные источники.',
    },
  },
  {
    q: {
      en: 'How does payment work?',
      ru: 'Как устроена оплата?',
    },
    a: {
      en: 'Fixed prices, split into milestones — typically 30/40/30 — so your prepayment never exceeds one milestone. Payment by bank transfer against an invoice; the account details and the currency are on the invoice. Invoices carry no VAT — EU and UK clients self-account for it under the reverse charge, with your VAT ID on the invoice; other jurisdictions owe none, and your finance team already knows this pattern. Monthly retainers are invoiced monthly and can be cancelled any month.',
      ru: 'Фиксированные цены, разбитые на этапы — обычно 30/40/30, — так что ваша предоплата никогда не превышает стоимость одного этапа. Оплата банковским переводом по выставленному счёту: реквизиты и валюта указаны в нём. Счета выставляются без VAT — клиенты из ЕС и Великобритании самостоятельно учитывают его по механизму reverse charge, с вашим VAT ID в счёте; для остальных юрисдикций VAT не применяется, и вашей бухгалтерии эта схема уже знакома. Ретейнеры выставляются помесячно, и отменить их можно в любой месяц.',
    },
  },
  {
    q: {
      en: 'How long do projects take?',
      ru: 'Сколько длятся проекты?',
    },
    a: {
      en: 'The audit: 5–10 business days. A RAG assistant pilot: three weeks. A website: three to five weeks. A self-hosted AI deployment: four to six weeks. The date is written into the contract next to the price — and if a date moves for a reason on my side, you hear about it before it moves, not after.',
      ru: 'Аудит — 5–10 рабочих дней. Пилот RAG-ассистента — три недели. Сайт — три-пять недель. Self-hosted AI-развёртывание — четыре-шесть недель. Дата записана в договоре рядом с ценой — и если срок сдвигается по причине на моей стороне, вы узнаёте об этом до того, как он сдвинется, а не после.',
    },
  },
  {
    q: {
      en: 'What about revisions and change requests?',
      ru: 'Что с правками и изменениями по ходу?',
    },
    a: {
      en: "Every package states its scope up front, so 'is this included?' has a written answer before it's ever asked. Anything beyond the written scope gets a quote before the work happens — never a surprise line on the invoice. Fixed price only works when the scope is honest in both directions.",
      ru: 'В каждом пакете заранее прописан скоуп, — так что вопрос «а это включено?» имеет письменный ответ ещё до того, как прозвучал. Всё, что выходит за прописанный скоуп, я оцениваю до начала работ — и это никогда не появляется сюрпризной строкой в счёте. Фиксированная цена работает только при честном скоупе в обе стороны.',
    },
  },
  {
    q: {
      en: "What if I'm not happy with the result?",
      ru: 'А если результат меня не устроит?',
    },
    a: {
      en: "Each rung has its own answer, in writing. The audit: if the report shows you nothing you can act on, you don't pay. The RAG pilot: we define an acceptance test together before work starts — fail it, and the final milestone isn't due. Websites: the Lighthouse target is contractual. Everything ships with a 30-day post-launch warranty, and milestone payments mean you never paid ahead beyond one step.",
      ru: 'У каждой ступени свой письменный ответ. Аудит: если в отчёте не окажется ничего, что можно применить, — вы не платите. RAG-пилот: приёмочный тест мы пишем вместе до начала работ — не пройден, финальный этап вы не оплачиваете. Сайты: целевой Lighthouse прописан в договоре. Всё сдаётся с 30-дневной гарантией после запуска, а оплата по этапам означает, что вперёд вы платили не больше одного этапа.',
    },
  },
  {
    q: {
      en: 'Who owns the code, the model and the data?',
      ru: 'Кому принадлежат код, модель и данные?',
    },
    a: {
      en: 'You do — all of it, in full, on final payment. The stack is deliberately standard and open (Astro, llama.cpp or vLLM, pgvector or Qdrant), the server is registered in your name, and the handover pack — documentation, runbook, credentials in your vault — is part of the deliverable, not an extra. Your data stays on infrastructure you control — that is the architecture, not a promise. What access I hold to it, and for how long, is a separate matter and it is agreed in writing before the work starts, rather than left to be inferred from that sentence.',
      ru: 'Вам — всё и полностью, с финальным платежом. Стек сознательно стандартный и открытый (Astro, llama.cpp или vLLM, pgvector или Qdrant), сервер оформлен на ваше имя, а handover-пакет — документация, runbook, учётные данные в вашем хранилище секретов — часть поставки, а не опция. Ваши данные остаются на инфраструктуре под вашим контролем — это архитектура, а не обещание. А то, какой доступ к ним есть у меня и на какой срок, — отдельный вопрос, и он фиксируется письменно до начала работ, а не выводится из этой фразы.',
    },
  },
  {
    q: {
      en: "You're one person. What happens if you're unavailable?",
      ru: 'Вы один человек. Что будет, если вы недоступны?',
    },
    a: {
      en: "The honest answer has two parts. Day to day: I reply within one business day in EU hours, in writing — a promise one engineer can actually keep, unlike a badge that promises more than any one person can deliver. Long term: every system is documented, runbook'd and built on standard components precisely so your own IT can take it over at any moment. The systems are designed to run when I can't be there — that has been the engineering rule here for a decade.",
      ru: 'Честный ответ из двух частей. В повседневности: я отвечаю в течение одного рабочего дня в часы ЕС, письменно — обещание, которое один инженер реально способен держать, в отличие от значка, обещающего больше, чем один человек способен выполнить. В долгую: каждая система задокументирована, у каждой есть runbook, и собрана она на стандартных компонентах именно затем, чтобы ваш IT мог принять её в любой момент. Системы спроектированы работать, когда меня нет рядом, — здесь это инженерное правило уже десять лет.',
    },
  },
  {
    q: {
      en: 'Do you work European hours? Where are you?',
      ru: 'Вы работаете в европейских часах? Где вы находитесь?',
    },
    a: {
      en: 'Gyumri, Armenia — GMT+4, which puts my working afternoon inside EU and UK business hours every single day. The workflow is async-first: briefs and deliverables live in documents, calls happen when they earn their slot. Cross-border is routine here: contracts with an English-law option, reverse-charge invoices with no VAT, communication in English.',
      ru: 'Гюмри, Армения — GMT+4: моя вторая половина дня каждый день попадает в рабочие часы ЕС и Великобритании. Процесс устроен async-first: брифы и результаты живут в документах, созвоны случаются, когда они того стоят. Трансграничная работа здесь — обычное дело: договоры с возможностью выбрать английское право, счета без VAT по механизму reverse charge, общение на английском.',
    },
  },
  {
    q: {
      en: 'Is VKVstudio a real business — and is it an agency?',
      ru: 'VKVstudio — это настоящий бизнес? Это агентство?',
    },
    a: {
      en: 'A registered sole proprietorship in Armenia since February 2026, with full registration and tax details in every contract and invoice. Not an agency — one engineer, on purpose: the person you talk to is the person who builds, and nothing is subcontracted behind your back. The Trust & Process page spells out the paperwork, the payment mechanics and the liability cap in advance.',
      ru: 'Зарегистрированный ИП в Армении с февраля 2026 года; полные регистрационные и налоговые реквизиты — в каждом договоре и счёте. Не агентство — один инженер, и это осознанно: человек, с которым вы разговариваете, и есть тот, кто делает работу, и ничего не отдаётся на субподряд за вашей спиной. Страница «Доверие и процесс» заранее описывает бумаги, механику оплаты и потолок ответственности.',
    },
  },
];
