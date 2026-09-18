/**
 * FE Iter 1 — XSS regression battery for renderInline (the render-time boundary).
 * ==============================================================================
 * renderInline feeds the terminal's only `{@html}` sink, so its output IS injected
 * as raw HTML. These tests pin the escape-then-transform contract: no attacker-
 * controlled markup may survive, only the two fixed <strong>/<code> templates.
 */
import { describe, it, expect } from 'vitest';
import { renderInline } from '@/lib/synapse-render';

// renderInline escapes every input '<' and '>' to entities, so the ONLY real tags
// that can appear in the output are its two fixed templates. Anything dangerous
// (script/img/svg/on*=/javascript:) is escaped to inert TEXT. The correct security
// assertion is therefore: every real <...> tag is an allowed template — a raw
// `onerror=` or `javascript:` appearing as escaped text is harmless.
const ALLOWED_TAG =
  /^(<\/?strong>|<\/?em>|<\/?code>|<code class="inline-code">|<span class="msg-(heading|bullet)">|<\/span>|<br>)$/;

function assertInert(html: string) {
  const tags = html.match(/<[^>]+>/g) ?? [];
  for (const t of tags) {
    expect(t).toMatch(ALLOWED_TAG);
  }
  // No unescaped '<' can start anything but an allowed tag: every raw '<' was
  // escaped, so a dangerous tag name only ever survives as "&lt;name".
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<iframe/i);
}

describe('renderInline — XSS battery', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe srcdoc="<script>alert(1)</script>">',
    '<ScRiPt>alert(1)</ScRiPt>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<img src=x onerror=alert&lpar;1&rpar;>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    // nested / mutation-XSS (the sanitizeResponse bypass) — renderInline escapes it
    '<<script>script>alert(1)<</script>/script>',
    '<img src=x o<script>nerror=alert(1)>',
  ];

  for (const p of payloads) {
    it(`neutralizes: ${p.slice(0, 40)}`, () => {
      assertInert(renderInline(p));
    });
  }

  it('escapes every literal < and > from input', () => {
    const out = renderInline('a < b > c & d');
    expect(out).toBe('a &lt; b &gt; c &amp; d');
  });

  it('script content becomes escaped text, not a tag', () => {
    const out = renderInline('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });
});

describe('renderInline — legitimate markdown still works', () => {
  it('renders bold', () => {
    expect(renderInline('hello **world**')).toBe('hello <strong>world</strong>');
  });

  it('renders inline code and escapes its content', () => {
    expect(renderInline('use `const x = <T>()`')).toBe(
      'use <code class="inline-code">const x = &lt;T&gt;()</code>'
    );
  });

  it('renders italic', () => {
    expect(renderInline('a *nice* word')).toBe('a <em>nice</em> word');
  });

  it('plain text passes through unchanged', () => {
    expect(renderInline('just a normal sentence.')).toBe('just a normal sentence.');
  });
});

describe('renderInline — model formatting HTML renders (safely) instead of showing tags', () => {
  it('renders <strong>/<b> as bold', () => {
    expect(renderInline('<b>bold</b>')).toBe('<strong>bold</strong>');
    expect(renderInline('<strong>bold</strong>')).toBe('<strong>bold</strong>');
  });

  it('renders <em>/<i> as italic', () => {
    expect(renderInline('<em>nice</em>')).toBe('<em>nice</em>');
  });

  it('renders <h2>…</h2> and ## as a heading span', () => {
    expect(renderInline('<h2>About</h2>')).toBe('<span class="msg-heading">About</span>');
    expect(renderInline('## About')).toBe('<span class="msg-heading">About</span>');
  });

  it('renders <li> and - as a bullet span', () => {
    expect(renderInline('- item')).toBe('<span class="msg-bullet">item</span>');
  });

  it('a dangerous tag disguised near allowed ones is still neutralised', () => {
    // <script> is NOT in the allowlist → escaped; <b> is → bold.
    assertInert(renderInline('<b>x</b><script>alert(1)</script>'));
    expect(renderInline('<b>x</b><script>alert(1)</script>')).toContain('&lt;script&gt;');
  });
});
