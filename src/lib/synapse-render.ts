/**
 * synapse-render.ts — the render-time XSS boundary for AI output.
 * ================================================================
 * `renderInline` is the function that actually protects the app: the Synapse
 * terminal renders every streamed model paragraph via `{@html renderInline(para)}`.
 *
 * SECURITY CONTRACT (do not weaken):
 *   1. HTML-escape `&`, `<`, `>` UNCONDITIONALLY — so no attacker-controlled raw
 *      markup can survive to the `{@html}` sink.
 *   2. The ONLY thing allowed to run before the escape is a fixed allowlist of
 *      well-known formatting tags the model itself emits (headings, <strong>/<b>,
 *      <em>/<i>, <br>, <li>, <p>…) → rewritten to MARKDOWN (`##`, `**`, `*`, `\n`,
 *      `- `). This never produces a raw `<`, and every OTHER `<…>` (e.g. `<script>`,
 *      `<img onerror>`) is NOT matched, so it falls straight through to the escape.
 *   3. After escaping, only fixed, non-attacker-controlled markdown templates run
 *      (headings, bullets, bold, italic, inline code) whose captured groups already
 *      contain escaped text and are never interpolated into an attribute.
 *
 * Net: escape-then-transform. The pre-escape step only ADDS markdown characters for
 * a closed allowlist of tags and removes those tags; it can't introduce an unescaped
 * `<`, so the full XSS battery (script/img/svg/iframe, javascript:/data:, on* handlers,
 * mixed-case/nested/mutation payloads) is still neutralised by step 1. Kept in its own
 * module so it's unit-tested (tests/unit/synapse-render.test.ts) and can't be silently
 * turned into a raw-passthrough by a future refactor.
 */
export function renderInline(text: string): string {
  // 0. Normalize a CLOSED allowlist of formatting tags the model sometimes emits
  //    (raw HTML) into markdown/newlines — BEFORE escaping. Only these exact tags
  //    are touched; anything else stays raw and is escaped in step 1.
  let s = text
    .replace(/<\/?(?:strong|b)>/gi, '**')
    .replace(/<\/?(?:em|i)>/gi, '*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(?:h[1-6]|li)>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol)[^>]*>/gi, '\n')
    // Collapse the runs of newlines those substitutions produce, and trim the ends,
    // so a `<h2>…</h2>` at a boundary doesn't leave stray leading/trailing breaks.
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '');

  // 1. Escape existing HTML chars (the security-critical step) for everything left.
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. Block-level markdown, line by line: headings (`# … ######`) and `-` bullets.
  //    (Runs on already-escaped text; `#`/`-` are never escaped so this is stable.)
  s = s
    .split('\n')
    .map((line) => {
      const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
      if (heading) return `<span class="msg-heading">${heading[1]}</span>`;
      const bullet = line.match(/^\s*-\s+(.+?)\s*$/);
      if (bullet) return `<span class="msg-bullet">${bullet[1]}</span>`;
      return line;
    })
    .join('<br>');

  // 3. Inline markdown — bold BEFORE italic so `**x**` isn't mis-read as italic.
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
}
