/**
 * Regexes shared between content-laws.test.ts (raw-source, site-wide scan)
 * and services-data.test.ts (structural scan over the imported SERVICES
 * data). Before 2026-08-22 each file hand-copied its own version of the
 * "no 24/7" law — content-laws.test.ts had one spelling, services-data.test.ts
 * had a near-identical but not-quite-identical one — so a future widening
 * applied to only one of them would silently leave the other file weaker
 * than its neighbour believed it to be. One export, two importers: the two
 * files physically cannot drift apart again.
 */

/**
 * Bans the "we are reachable/available every hour of every day" promise in
 * every phrasing the site's own house style or a careless edit could
 * plausibly produce — not just the four literal spellings ("24/7", "24x7",
 * "around the clock", "круглосуточно...") the pre-audit law matched.
 *
 * An adversarial review (2026-08-22) found the old pattern let through: the
 * most natural English phrasing of the exact same promise ("round-the-clock
 * monitoring", "we watch it round the clock" — note "around the clock" does
 * NOT substring-match "round-the-clock", so both spellings are listed),
 * "24×7"/"24⁄7" (U+00D7/U+2044 look-alike separators a copy-paste from a
 * spec sheet can introduce), "twenty-four hours a day, seven days a week",
 * "always-on ... any hour you need it", and the Russian equivalents
 * «24 часа в сутки, без выходных», «в любое время суток», «круглые сутки».
 * Separately, src/pages/[lang]/services/geo-methodology/index.astro:20 (a
 * frontmatter comment, so exempt via stripComments) already writes
 * "no round-the-clock SLA promise" — the exact phrase this widening closes,
 * one copy-paste away from landing in real copy.
 *
 * Exemption: content-laws.test.ts masks out services.ts's `notIncluded`
 * text before running this pattern — that is the one place on the site
 * allowed to NAME what it does not offer ("no 24/7 SLA. You get..."). See
 * that file for the masking logic; this constant only defines what counts
 * as the promise, not where it is allowed to be named.
 */
export const CLOCK =
  /24\s*[/\-x×⁄∕:]\s*7|twenty[- ]four hours|seven days a week|(?:a|А)?round[- ]the[- ]clock|круглосуточн[а-яё]*|круглые\s+сутки|24\s*часа\s*в\s*сутки|без\s+выходных|в\s+любое\s+время\s+суток|днём\s+и\s+ночью|always[- ]on\s+(?:support|monitoring|cover)|at\s+any\s+hour/gi;
