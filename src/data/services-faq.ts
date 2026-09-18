/**
 * Per-service mini-FAQs — rendered by FaqSection on the rung pages and
 * mirrored into their FAQPage JSON-LD, same single-source discipline as
 * faq.ts. These answer the questions a buyer asks BEFORE writing to a
 * stranger abroad; the general buyer FAQ on the homepage covers process
 * and payment for everything.
 */
import type { FaqItem } from '@/data/faq';

export const SERVICES_FAQ: Record<
  'geo-audit' | 'rag-pilot' | 'on-prem-ai' | 'websites',
  FaqItem[]
> = {
  'geo-audit': [
    {
      q: {
        en: 'Can you guarantee my company shows up in ChatGPT answers?',
        ru: 'Вы можете гарантировать, что моя компания появится в ответах ChatGPT?',
      },
      a: {
        en: 'No — and nobody honestly can. AI answers are non-deterministic and there is no search console for ChatGPT or Perplexity. What I guarantee is the deliverable: a measured baseline, the specific gaps that keep engines from citing you, and fixes ranked by impact. The methodology page spells out exactly what is measurable and what is not — that page exists because this market is full of people promising rankings they cannot see.',
        ru: 'Нет — и честно этого не может никто. ИИ каждый раз отвечает чуть иначе, а search console для ChatGPT или Perplexity не существует. Я гарантирую результат работы: измеренный базовый уровень, конкретные пробелы, из-за которых движки вас не цитируют, и список исправлений, выстроенный по силе эффекта. На странице методологии прямо написано, что измеримо, а что нет, — она существует потому, что этот рынок полон людей, обещающих позиции, которых они не видят.',
      },
    },
    {
      q: {
        en: 'Is this just SEO with a new name?',
        ru: 'Это просто SEO под новым названием?',
      },
      a: {
        en: 'Partly — and anyone who denies that is selling something. A large share of AI visibility is downstream of solid technical SEO. The parts that are genuinely different: entity consistency, machine-readable structure (schema depth, llms.txt), AI-crawler access, and content shaped so an answer engine can lift and cite it. I do the audit as an engineer: everything I flag comes with the exact change to make, not a slogan.',
        ru: 'Отчасти — и тот, кто это отрицает, что-то продаёт. Значительная часть ИИ-видимости стоит на добротном техническом SEO. Что действительно новое: согласованность сущности, машиночитаемая структура (глубина schema, llms.txt), доступ ИИ-краулеров и контент, который движку удобно взять и процитировать. Я делаю аудит как инженер: к каждому замечанию приложено конкретное изменение, а не лозунг.',
      },
    },
    {
      q: {
        en: 'What do I need to give you for the audit?',
        ru: 'Что от меня нужно для аудита?',
      },
      a: {
        en: 'Only your domain and the names of two or three competitors. No analytics access, no logins, no accounts, nothing of yours copied to my side — everything is measured from the outside, exactly the way the AI engines see you. That is why the audit can start the day you order it, with no setup call and nothing for your IT to arrange.',
        ru: 'Только домен и названия двух-трёх конкурентов. Без доступа к аналитике, без логинов, без аккаунтов, ничего вашего ко мне не копируется — всё измеряется снаружи, ровно так, как вас видят ИИ-движки. Поэтому аудит может начаться в день заказа: ни установочного созвона, ни задач вашему IT.',
      },
    },
  ],
  'rag-pilot': [
    {
      q: {
        en: 'What if the assistant gives a wrong answer?',
        ru: 'Что, если ассистент даст неверный ответ?',
      },
      a: {
        en: 'It will, sometimes — no retrieval system is perfect, and pretending otherwise would be the bigger risk. The acceptance test we write together before work starts sets the accuracy bar the pilot has to clear, on real questions against your real documents, not a demo set. The system is built to answer "that is not in the documents" rather than guess, and every answer carries its source passage, so your team verifies it in seconds instead of trusting it blindly.',
        ru: 'Иногда — да. Ни одна система поиска не идеальна, и делать вид, что это не так, было бы куда рискованнее. Приёмочный тест, который мы пишем вместе до начала работ, задаёт планку точности, которую пилот обязан взять, — на реальных вопросах к вашим реальным документам, а не на демо-наборе. Система устроена так, чтобы отвечать «этого нет в документах», а не гадать, и к каждому ответу приложен исходный фрагмент — ваша команда проверяет его за секунды, а не верит на слово.',
      },
    },
    {
      q: {
        en: 'Our documents are confidential. What happens to them?',
        ru: 'Наши документы конфиденциальны. Что с ними происходит?',
      },
      a: {
        en: "They stay on your infrastructure — your server, or a dedicated EU machine registered to you. I work inside your controlled environment; your documents are never uploaded to my systems and nothing trains a model. Confidential is not the same thing as personal, and the distinction decides how the engagement is set up: the fixed pilot is scoped to corpora that carry no personal data — technical documentation, engineering manuals, standards and internal regulations, product catalogues, specifications. If the set you have in mind holds personal data instead, say so in your first message: that engagement is arranged and papered differently, and how it is classified is your DPO's call, not this page's.",
        ru: 'Они остаются на вашей инфраструктуре — вашем сервере или выделенной машине в ЕС, оформленной на вас. Я работаю внутри вашего контролируемого контура; ваши документы не выгружаются в мои системы и не уходят на обучение моделей. Конфиденциальный и персональный — не одно и то же, и от этой разницы зависит, как устроена работа: фиксированный пилот рассчитан на наборы документов без персональных данных — техническая документация, инженерные руководства, стандарты и внутренние регламенты, каталоги продукции, спецификации. Если у вас на примете набор с персональными данными — скажите об этом в первом письме: такой проект устроен и оформлен иначе, а как его квалифицировать, решает ваш DPO, а не эта страница.',
      },
    },
    {
      q: {
        en: 'Why not just use ChatGPT (or a custom GPT) with our files?',
        ru: 'Почему не использовать ChatGPT (или custom GPT) с нашими файлами?',
      },
      a: {
        en: "You can, for a quick internal experiment — and for some teams that is genuinely enough. I will say so rather than sell a pilot nobody needs. Where it breaks at scale: uploaded files sit on a third party's infrastructure, which is a hard no for regulated data; there is no acceptance test or measured accuracy; retrieval quality on large or messy document sets is unpredictable; and per-seat subscription cost scales with headcount, not with usage. The pilot exists to answer, with evidence, which side of that line your case is actually on.",
        ru: 'Можно — для быстрого внутреннего эксперимента: некоторым командам этого действительно достаточно. В таком случае я так и скажу, а не продам ненужный пилот. Где это ломается на масштабе: загруженные файлы лежат на инфраструктуре третьей стороны — для регулируемых данных это прямое «нет»; нет приёмочного теста и измеренной точности; качество поиска на больших или неструктурированных наборах документов непредсказуемо; а цена подписки за место растёт вместе со штатом, а не с использованием. Пилот и существует, чтобы доказательно ответить, на какой стороне этой границы находится именно ваш случай.',
      },
    },
    {
      q: {
        en: 'What does production actually cost after the pilot?',
        ru: 'Сколько на самом деле стоит продакшн после пилота?',
      },
      a: {
        en: 'The pilot itself is €4,500, fixed. Typical production rollouts — multi-source connectors, SSO, role-based access, more documents — run €10,000–20,000, and you get your real number only after the pilot proves retrieval works on your documents, not before. The optional Care Plan that follows starts from €1,500/month for monitoring, index updates and prompt tuning; nothing after the pilot is required.',
        ru: 'Сам пилот стоит €4 500, фиксированная цена. Типичный продакшн-запуск — коннекторы к нескольким источникам, SSO, разграничение доступа, больший объём документов — стоит €10 000–20 000, и точную цифру вы узнаете только после того, как пилот докажет, что поиск работает на ваших документах, а не заранее. Опциональное сопровождение (Care Plan) после пилота — от €1 500/месяц: мониторинг, обновление индекса, тюнинг промптов; ничего из этого не обязательно.',
      },
    },
    {
      q: {
        en: 'What happens if you disappear? You are one person.',
        ru: 'Что будет, если вы исчезнете? Вы один человек.',
      },
      a: {
        en: 'The system is built so the answer is "nothing dramatic": a standard open stack, full documentation, a runbook, and a handover pack your IT can pick up at any moment. That is a design requirement, not a courtesy — my own engineering rule is "will this still work when I can\'t be there?" The Care Plan exists for teams who prefer I keep maintaining it; leaving it is always possible, which is exactly why staying is safe.',
        ru: 'Система построена так, чтобы ответ был «ничего драматичного»: стандартный открытый стек, полная документация, runbook и handover-пакет, который ваш IT может подхватить в любой момент. Это требование архитектуры, а не жест вежливости — моё собственное инженерное правило: «будет ли это работать, когда меня не будет рядом?» Care Plan — для команд, которым удобнее оставить поддержку мне; уйти можно всегда, и именно поэтому оставаться безопасно.',
      },
    },
    {
      q: {
        en: 'Do we need to buy or rent our own server for the pilot?',
        ru: 'Нужно ли покупать или арендовать сервер под пилот?',
      },
      a: {
        en: 'Buying one is not required — renting a modest one is enough. A pilot-scale document set runs comfortably on a single dedicated EU server (Hetzner, OVH-class) rented in YOUR name for a few hundred euros a month — the same infrastructure story as the self-hosted AI track, just at pilot scale, not a fleet. Arranging that server is usually the first practical step, so it is worth starting before the three-week clock begins, not partway through it.',
        ru: 'Покупать не нужно — достаточно арендовать скромный. Набор документов пилотного масштаба спокойно работает на одном выделенном сервере в ЕС (класса Hetzner, OVH), арендованном на ВАШЕ имя за несколько сотен евро в месяц — та же инфраструктурная история, что и на self-hosted AI, только в масштабе пилота, а не парка серверов. Договориться об этом сервере обычно стоит первым делом — до того, как пойдёт отсчёт трёх недель, а не в середине.',
      },
    },
  ],
  'on-prem-ai': [
    {
      q: {
        en: 'Do we have to buy servers?',
        ru: 'Нам нужно покупать серверы?',
      },
      a: {
        en: 'Usually not. In practice, self-hosting for a European SME means a machine you control: your existing rack if you already have one, or a dedicated EU server (Hetzner, OVH) rented in YOUR name for a few hundred euros a month. What matters for compliance is that the hardware, the model and the data are yours, in a jurisdiction you chose — not whose basement the machine happens to sit in. Proof that this runs on modest hardware: the assistant on this very site, self-hosted on a 4-core ARM box.',
        ru: 'Обычно нет. На практике self-hosting для европейского малого и среднего бизнеса — это машина под вашим контролем: ваша стойка, если она уже есть, или выделенный сервер в ЕС (Hetzner, OVH), арендованный на ВАШЕ имя за несколько сотен евро в месяц. Для комплаенса важно то, что железо, модель и данные — ваши, в выбранной вами юрисдикции, а не то, в чьём подвале стоит машина. Доказательство, что это работает на скромном железе, — ассистент этого сайта, self-hosted на 4-ядерной ARM-машине.',
      },
    },
    {
      q: {
        en: 'Who patches it once it is running?',
        ru: 'Кто патчит систему после запуска?',
      },
      a: {
        en: 'You can, or I can — and it is worth keeping the two apart, because they are two different agreements. The deployment ends with your team holding every key: full documentation, a runbook and a handover pack exist precisely so your own IT is never locked out, and I need no access to your live system to finish the job. If you would rather not carry the upkeep yourself, the optional Sovereign Care retainer (€1,500–3,000/month) covers monitoring and security patches — and that is where access gets defined in writing before it exists: named, time-boxed, logged on your side, revoked when the ticket closes. Cancel any month: the whole point of the handover pack is that leaving is always possible.',
        ru: 'Патчить может ваша команда, могу и я, — и эти две вещи стоит держать порознь, потому что это два разных договора. Развёртывание заканчивается тем, что все ключи у вас: полная документация, runbook и handover-пакет существуют именно для того, чтобы ваш IT никогда не оказался заблокирован, а мне для завершения работ доступ к живой системе не нужен. Если не хотите брать сопровождение на себя, опциональный Sovereign Care (€1 500–3 000/месяц) закрывает мониторинг и патчи безопасности — и вот там доступ описывается письменно ещё до того, как появится: именной, ограниченный по времени, журналируемый на вашей стороне, отзываемый по закрытии заявки. Отмена в любой месяц — в этом и смысл handover-пакета: уйти можно всегда.',
      },
    },
    {
      q: {
        en: 'What if the model goes stale — will a small open model keep up?',
        ru: 'Что, если модель устареет: будет ли малая открытая модель поспевать за прогрессом?',
      },
      a: {
        en: 'The stack is standard and swappable by design — llama.cpp or vLLM, nothing proprietary — so moving to a stronger open model later is a deployment task, not a rebuild. For narrow-domain work — answering from your documents, in your formats, in your terminology — a fine-tuned small model already performs at a level you used to pay GPT-4 prices for; when a task genuinely needs frontier reasoning, the honest answer is a hybrid: sensitive work stays local, while that one task goes to an EU-hosted API. The Sovereign Care retainer tracks open-weight releases and applies upgrades once they clear your acceptance test; without it, the system keeps running exactly as delivered, just without the upgrades.',
        ru: 'Стек стандартный и взаимозаменяемый по замыслу — llama.cpp или vLLM, ничего проприетарного, — поэтому переход на более сильную открытую модель позже — это задача развёртывания, а не пересборка с нуля. Для узких доменных задач (отвечать по вашим документам, вашим форматам, вашей терминологии) дообученная малая модель уже работает на уровне, за который вы раньше платили по ценам GPT-4; когда задаче действительно нужен уровень рассуждений frontier-модели, честный ответ — гибрид: чувствительное остаётся локально, эта одна задача уходит в EU-hosted API. Сопровождение Sovereign Care отслеживает выход открытых весов и применяет обновления, когда они проходят ваш приёмочный тест; без него система продолжает работать точно так же, как была сдана, — просто без обновлений.',
      },
    },
    {
      q: {
        en: 'What happens when you are not available?',
        ru: 'Что происходит, когда вы недоступны?',
      },
      a: {
        en: 'You get a written response within one business day, in EU hours (the engineer works from GMT+4) — the honest promise one engineer can actually keep, not a nonstop-availability guarantee that no studio of this size could actually keep. It matters less than it sounds: the deployment is documented, standard and self-hosted on infrastructure you own, so your own IT can operate and even patch it without me. That is a design requirement, not a courtesy — the same rule the RAG pilot is built to.',
        ru: 'Вы получаете письменный ответ в течение одного рабочего дня, в рабочие часы ЕС (инженер работает из часового пояса GMT+4) — честное обещание, которое один инженер способен сдержать, а не гарантия постоянной доступности, которую при моём масштабе не смог бы выполнить никто. На практике это значит меньше, чем звучит: развёртывание задокументировано, стандартно и self-hosted на вашей инфраструктуре, так что ваш IT может эксплуатировать и даже патчить систему без меня. Это требование архитектуры, а не жест вежливости — то же правило, по которому построен RAG-пилот.',
      },
    },
    {
      q: {
        en: 'Why not just use Azure OpenAI with a DPA? Our lawyers accept it.',
        ru: 'Почему не просто Azure OpenAI с DPA? Наши юристы его принимают.',
      },
      a: {
        en: 'For many workloads you should — and if the readiness assessment says an EU-hosted API covers your case, that is what the report will say. The honest reasons to self-host: the US CLOUD Act reaches US providers regardless of the DPA; hosted APIs carry abuse-monitoring and telemetry caveats; per-token pricing turns success into a variable cost; and a hosted model can be deprecated out from under your workflows. Self-hosting trades convenience for jurisdiction, fixed cost, and a model nobody can take away.',
        ru: 'Для многих задач так и нужно — и если оценка готовности покажет, что вашу задачу закрывает EU-hosted API, именно это и будет написано в отчёте. Честные причины для self-hosting: американский CLOUD Act дотягивается до провайдеров из США независимо от DPA; у hosted-API есть оговорки про abuse-мониторинг и телеметрию; потокенная цена превращает успех в переменные расходы; а hosted-модель могут вывести из эксплуатации прямо из-под ваших процессов. Self-hosting меняет удобство на юрисдикцию, фиксированную стоимость и модель, которую никто не отберёт.',
      },
    },
  ],
  websites: [
    {
      q: {
        en: 'Why €3,500–5,500 when site builders are free?',
        ru: 'Почему €3 500–5 500, если конструкторы сайтов бесплатны?',
      },
      a: {
        en: "Squarespace and Webflow are free to start, and that's exactly the point — you pay for whatever the builder decided your page needs, whether your visitor needs it or not. €3,500–5,500 buys three things a builder can't: a Lighthouse target measured on the real page with your real content, not an empty demo template; AI-crawler readiness built into the markup from day one; and a codebase you actually own and can hand to anyone. This site is the demo — measure it yourself.",
        ru: 'Squarespace и Webflow бесплатны на старте, и в этом всё дело: вы платите за всё, что конструктор счёл нужным для вашей страницы, — независимо от того, нужно ли это вашему посетителю. За €3 500–5 500 вы получаете три вещи, которых конструктор дать не может: целевой балл Lighthouse, измеренный на реальной странице с вашим контентом, а не на пустом шаблоне; готовность к ИИ-краулерам, встроенную в разметку с первого дня; и код, которым владеете вы и который можно передать кому угодно. Этот сайт — и есть демо, измерьте сами.',
      },
    },
    {
      q: {
        en: 'Is Lighthouse 100 realistic with real content?',
        ru: 'Реалистичен ли Lighthouse 100 с реальным контентом?',
      },
      a: {
        en: 'Yes on most pages — and it\'s written into the contract, not promised verbally. Most "100" scores you see online are measured on an empty template before real images, fonts and tracking scripts land. This site measures 100 on desktop on the pages without a video hero, and 99 on the homepage, which runs a full scroll-driven video — a harder case than most marketing pages you will ever ship. The target is set per project against your real content, and the final milestone waits until it is hit.',
        ru: 'На большинстве страниц — да, и это прописано в договоре, а не обещано на словах. Большинство «соток» в сети измерено на пустом шаблоне — до того, как в него попали настоящие изображения, шрифты и трекинг-скрипты. Этот сайт даёт 100 на десктопе там, где видео нет, и 99 на главной, где крутится полноценное видео на прокрутке, — случай тяжелее, чем почти любая маркетинговая страница, которую вы когда-либо запустите. Цель ставится под ваш проект по вашему реальному контенту, и финальный платёж ждёт, пока цель не достигнута.',
      },
    },
    {
      q: {
        en: 'Do you migrate or redesign existing sites?',
        ru: 'Вы переносите или переделываете существующие сайты?',
      },
      a: {
        en: 'Yes — and it splits into two jobs with two different starting points. A redesign runs exactly like a new build: content and structure carry over from exports you hand me, nothing needs a login to your production admin, and the fixed scope and terms are identical. A migration that has to carry a live user base across — accounts, orders, submitted-form history, a CMS full of real profiles — is the other job: it starts with a written agreement on who touches that data and how, before we talk scope, and it is quoted separately. Either way the AI-visibility checklist runs against your existing pages first, so decisions are grounded in what is actually broken, not a guess; if you have already ordered the €900 audit, its findings roll straight into the scope.',
        ru: 'Да — и это распадается на две разные работы с разными точками старта. Редизайн идёт ровно как новый сайт: контент и структура переносятся из выгрузок, которые вы передаёте, доступ в админку продакшена не нужен, скоуп и условия те же самые. Миграция, при которой надо перенести живую базу пользователей — учётные записи, заказы, историю отправленных форм, CMS с реальными профилями, — это вторая работа: она начинается с письменной договорённости о том, кто и как касается этих данных, ещё до разговора о скоупе, и оценивается отдельно. В обоих случаях чек-лист ИИ-видимости сначала прогоняется по вашим текущим страницам, так что решения опираются на то, что реально сломано, а не на догадку; а если вы уже заказали аудит за €900, его выводы сразу входят в скоуп.',
      },
    },
    {
      q: {
        en: 'Who owns the code once the site is live?',
        ru: 'Кому принадлежит код после запуска сайта?',
      },
      a: {
        en: 'You do — the repository and everything in it, transferred on final payment. No licensing fee, no "powered by" lock-in, no proprietary CMS you rent by the month. It is a standard Astro codebase with vanilla CSS: any engineer, in-house or hired later, can open it and work without translating it out of a platform first.',
        ru: 'Вам. Репозиторий и всё, что в нём, переходят к вам с финальным платежом. Без лицензионных отчислений, без обязательной плашки «Powered by», без проприетарной CMS в аренду помесячно. Это стандартный код на Astro с чистым CSS: любой инженер — ваш штатный или нанятый позже — сможет открыть его и работать, не перенося сначала с чужой платформы.',
      },
    },
  ],
};
