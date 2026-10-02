/**
 * Site-wide facts that appear in more than one place.
 *
 * `CONTACT_EMAIL` exists because this address had already drifted apart once.
 * The contact button pointed at a personal Gmail while the Organization and
 * Person JSON-LD both still advertised hello@vkvstudio.com — so the page a
 * human clicked and the graph a crawler read disagreed about how to reach the
 * studio, and neither was obviously wrong from inside its own file. One
 * constant with several consumers cannot drift.
 *
 * NOTE: `public/llms.txt` is a static asset and cannot import this. It carries
 * the same address by hand; change it in the same commit.
 */

/**
 * The one address the site tells the world to use.
 *
 * This MUST be an address that actually receives mail. It is not a detail: this
 * is the site's only conversion path, and the last time it pointed somewhere
 * undeliverable, every enquiry bounced and the owner learned nothing about it —
 * the domain had no MX record at all while the button advertised a branded
 * address anyway.
 *
 * Before it was set here, all three of these were checked rather than assumed:
 * the domain's MX resolves to smtp.google.com with SPF and DKIM published
 * (queried against 1.1.1.1, not read off a dashboard); hello@ is registered as
 * an alias on the owner's Workspace mailbox; and a test message addressed to
 * hello@ was watched landing in that mailbox.
 *
 * If this ever needs to change again, repeat that: resolve the MX, confirm the
 * mailbox or alias exists, send something to it and watch it arrive. Editing
 * this line is thirty seconds. Discovering months later that nobody could reach
 * you is not recoverable.
 */
export const CONTACT_EMAIL = 'hello@vkvstudio.com';
