/**
 * Guards the homepage boot cost of the Synapse island, the resilience of its
 * lazy terminal, and the rendering fixes that shipped with it (Lighthouse
 * 13.5 mobile, 2026-09-20; wave-3 audit fixes 2026-09-21).
 *
 * These assertions read source, not behaviour — the same reasoning as
 * chat-scoping.test.ts. What they guard is cheap to reintroduce by accident
 * and invisible to a functional test:
 *
 *  - SynapseApp.*.js cost 1635 ms total / 1569 ms scripting in bootup-time on
 *    a page load where nobody had opened the chat, because SynapseTerminal was
 *    a static import mounted at client:idle. One `import SynapseTerminal from`
 *    line at the top of SynapseApp brings the whole bill back and every unit
 *    test still passes.
 *  - The orb collapsed (scale 0) the moment it was clicked, before the
 *    terminal chunk had landed: a 503 on the chunk left a zero-size orb with
 *    no hit area and no assistant until reload; a slow chunk left neither orb
 *    nor terminal on screen for the whole download (audit 2026-09-21).
 *  - Unconditional window-load prefetch evaluated the terminal graph even
 *    when the visitor never reached the scroll gate. Fetching now starts on
 *    readiness / intent; an immediate first open may wait for that work.
 *  - div.synapse-container transitioned `bottom` to ride above the footer /
 *    cookie sheet: a non-composited animation AND 0.0162 of the page's 0.0163
 *    CLS, because a fixed element moving through `bottom` is a layout shift
 *    while a transform is not.
 *  - span.sidebar-logo__dot pulsed its own box-shadow (non-composited).
 *  - aside.sidebar-panel carried role="navigation", which aside may not
 *    (axe aria-allowed-role).
 *  - SynapseTerminal's scoped CSS (28.9 KB raw) was hoisted into the homepage
 *    stylesheet by Astro's CSS collection even though the JS was lazy, and
 *    inlined render-blocking into every /en/ and /ru/ load.
 *
 * Comments are stripped before matching (house pattern, see
 * webmcp-idle-defer.test.ts): a sentence describing the fix must not be able
 * to satisfy an assertion about the fix. The previous version of this file
 * matched `onpointerenter={handleIntent}` against raw source, so a `//` line
 * mentioning the handler kept the suite green with the handler deleted, and
 * counted `Terminal =` assignments with a line-start anchor, so a mount
 * written as `.then(() => (Terminal = terminalModule))` inside the warm-up
 * was invisible (both found by the 2026-09-21 audit).
 *
 * The original assertions were mutation-proved on 2026-09-21 against copies of
 * the guarded files in a scratch tree (the repo files were never modified):
 * each mutation listed next to a test turns that test red, and the unmutated
 * copies are green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Drop HTML, block and line comments. A `//` is only a comment when nothing
 * but whitespace precedes it on the line or a space does — `'https://…'`
 * inside a string literal keeps its slashes.
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
}

const APP = stripComments(read('../../src/components/ui/SynapseApp.svelte'));
const BRAIN = stripComments(read('../../src/components/ui/SynapseBrain.svelte'));
const SIDEBAR = stripComments(read('../../src/components/ui/SynapseSidebar.svelte'));
const TERMINAL = stripComments(read('../../src/components/ui/SynapseTerminal.svelte'));
const INDEX = stripComments(read('../../src/pages/[lang]/index.astro'));

/** The <style> block of a Svelte single-file component. */
function styleOf(src: string): string {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
  if (!m) throw new Error('no <style> block');
  return m[1]!;
}

/** Body of the balanced `{ … }` block that starts at the first `{` after `start`. */
function blockAfter(src: string, start: number): string {
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error('no block');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    if (depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced block');
}

/** Body of a top-level `function name(…)` in a script. Throws when absent, so
    a renamed function fails loudly instead of matching an empty string. */
function functionBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\(`));
  if (at === -1) throw new Error(`function ${name} not found`);
  return blockAfter(src, at);
}

/** Every `@keyframes name { ... }` body, keyed by name. */
function keyframesOf(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out[m[1]!] = blockAfter(css, m.index + m[0].length - 1);
  }
  return out;
}

/** Every balanced `@media (…) { … }` body whose query matches `query`. */
function mediaBlocks(css: string, query: RegExp): string[] {
  const out: string[] = [];
  const re = /@media\s*([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (query.test(m[1]!)) out.push(blockAfter(css, m.index + m[0].length - 1));
  }
  return out;
}

/** The opening tag of the element carrying `role="button"` — the orb itself,
    not a comment about it and not the tooltip. */
function orbTag(): string {
  const m = /<div\b[^>]*\brole="button"[^>]*>/.exec(BRAIN);
  if (!m) throw new Error('no <div role="button"> in SynapseBrain');
  return m[0];
}

describe('SynapseApp — the terminal is not part of the homepage boot', () => {
  it('SynapseTerminal is a dynamic import, never a static one', () => {
    // A type-only import is fine: it is erased and fetches nothing.
    // Mutation: `import SynapseTerminal from '@/components/ui/SynapseTerminal.svelte';`
    const staticImports = [...APP.matchAll(/^\s*import\s+(?!type\b)[^;]*SynapseTerminal[^;]*;/gm)];
    expect(staticImports, 'static import of SynapseTerminal found').toEqual([]);
    expect(APP).toMatch(/import\(\s*['"]@\/components\/ui\/SynapseTerminal\.svelte['"]\s*\)/);
  });

  it('the terminal mounts only once its chunk has landed, and stays mounted', () => {
    // Mutation: `{#if Terminal && terminalOpen}` — unmounting on close would
    // throw away chat state, the audio engine and the auth subscription.
    expect(APP).toMatch(/\{#if Terminal\}/);
    expect(APP).not.toMatch(/\{#if Terminal\s*&&/);
  });

  it('`Terminal` (the mount) is assigned in exactly one place: inside mountTerminal', () => {
    // Not anchored to a line start and run on comment-free source, so a
    // mount hidden inside an expression — `.then(() => (Terminal = mod))`
    // in the warm-up — counts too. `let Terminal = $state(…)` is the
    // declaration, not a mount; `!==` / `===` are not assignments.
    // Mutation: add `.then(() => (Terminal = terminalModule))` to warmTerminal.
    const assignRe = /(?<!let\s+)(?<![\w.$])Terminal\s*=(?!=)/g;
    const assigns = [...APP.matchAll(assignRe)];
    expect(assigns).toHaveLength(1);
    expect([...functionBody(APP, 'mountTerminal').matchAll(assignRe)]).toHaveLength(1);
  });

  it('the scroll-gate warm-up mounts only on coarse pointers; fine pointers wait for intent', () => {
    expect(APP).toMatch(/onReady=\{warmTerminal\}/);
    expect(APP).toMatch(/onIntent=\{mountTerminal\}/);
    const warm = functionBody(APP, 'warmTerminal');
    expect(warm).toMatch(/fetchTerminal\(\)/);
    // The coarse-pointer guard must come before the mount call, so a mouse
    // user's scroll never mounts the terminal.
    // Mutation A: delete the `if (!coarsePointer()) return;` line.
    // Mutation B: move `mountTerminal()` above the guard.
    const guardAt = warm.search(/if \(!coarsePointer\(\)\) return;/);
    const mountAt = warm.search(/mountTerminal\(\)/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(mountAt).toBeGreaterThan(guardAt);
    expect(functionBody(APP, 'coarsePointer')).toMatch(/\(hover: none\), \(pointer: coarse\)/);
  });

  it('the chunk waits for readiness or intent, with no boot-triggered prefetch', () => {
    // Regression: restoring a hydration / window-load prefetch evaluates the
    // terminal graph on visits that never approach the orb's scroll gate.
    expect(APP).not.toMatch(/\bonMount\s*\(|\bprefetchTerminal\b|\breadyState\b/);
    expect(APP).not.toMatch(/\$effect(?:\.pre)?\s*\(/);
    expect(APP).not.toMatch(/addEventListener\(\s*['"](?:load|DOMContentLoaded)['"]/);
    // One declaration and exactly two calls: mount intent and scroll readiness.
    expect([...APP.matchAll(/\bfetchTerminal\(\)/g)]).toHaveLength(3);
    // Wrapper calls must not provide another route from component boot.
    expect([...APP.matchAll(/\bwarmTerminal\(\)/g)]).toHaveLength(1);
    expect([...APP.matchAll(/\bmountTerminal\(\)/g)]).toHaveLength(3);
    expect(functionBody(APP, 'mountTerminal')).toMatch(/fetchTerminal\(\)/);
    expect(functionBody(APP, 'warmTerminal')).toMatch(/fetchTerminal\(\)/);
    expect(APP).toMatch(/onReady=\{warmTerminal\}/);
    expect(APP).toMatch(/onIntent=\{mountTerminal\}/);
  });

  it('the orb never collapses before the terminal is mounted', () => {
    // `collapsed` must derive from Terminal being non-null, not from the wish
    // alone, and the orb must receive that derived value.
    // Mutation A: `const collapsed = $derived(terminalOpen);`
    // Mutation B: `collapsed={terminalOpen}` on <SynapseBrain>.
    expect(APP).toMatch(/const collapsed = \$derived\(terminalOpen && Terminal !== null\);/);
    expect(APP).toMatch(/const pending = \$derived\(terminalOpen && Terminal === null\);/);
    const brainTag = /<SynapseBrain\b[\s\S]*?\/>/.exec(APP)?.[0] ?? '';
    expect(brainTag).toMatch(/\{collapsed\}/);
    expect(brainTag).toMatch(/\{pending\}/);
    expect(brainTag).toMatch(/\{failed\}/);
    expect(brainTag).not.toMatch(/collapsed=\{terminalOpen\}/);
  });

  it('a failed open withdraws the wish and counts the failure; a mount resets the count', () => {
    // Mutation A: delete `terminalOpen = false;` from the failure branch —
    // the orb would sit in `pending` forever after a 503.
    // Mutation B: delete `loadFailures += 1;` — the reload message never shows.
    const open = functionBody(APP, 'openTerminal');
    expect(open).toMatch(/if \(terminalOpen\) return;/);
    expect(open).toMatch(/terminalOpen = false;/);
    expect(open).toMatch(/loadFailures \+= 1;/);
    expect(open).toMatch(/loadFailures = 0;/);
    expect(APP).toMatch(/const failed = \$derived\(loadFailures >= 2\);/);
    // The loader itself forgets a failed attempt so the next call re-imports.
    expect(functionBody(APP, 'fetchTerminal')).toMatch(/\.catch\([\s\S]*?terminalLoad = null/);
  });

  it('the orchestrator carries no GSAP (the collapse is a CSS transition)', () => {
    expect(APP).not.toMatch(/from 'gsap'/);
  });

  it('the island stays idle-hydrated on the homepage, never client:load', () => {
    expect(INDEX).toMatch(/<SynapseApp client:idle/);
    expect(INDEX).not.toMatch(/<SynapseApp[^>]*client:load/);
  });

  it('the orb element itself fires intent before the click can (pointer, focus) and on ready', () => {
    // Anchored to the <div role="button"> tag on comment-free source: a
    // comment naming the handlers cannot satisfy this.
    // Mutation: remove both handlers from the element and mention them in a
    // `//` comment above handleIntent.
    const tag = orbTag();
    expect(tag).toContain('onpointerenter={handleIntent}');
    expect(tag).toContain('onfocus={handleIntent}');
    expect(tag).toContain('onclick={handleClick}');
    expect(functionBody(BRAIN, 'handleIntent')).toMatch(/onIntent\?\.\(\)/);
    // The ready warm-up must be a one-shot: `.ready` toggles with every
    // scroll past #about.
    const effect = BRAIN.slice(BRAIN.indexOf('new MutationObserver'));
    expect(effect).toMatch(/onReady\?\.\(\)/);
    expect(BRAIN).toMatch(/readyAnnounced = true/);
  });

  it('the orb reports the pending and failed states to assistive tech', () => {
    const tag = orbTag();
    // Mutation: drop `aria-busy` from the tag.
    expect(tag).toMatch(/aria-busy=\{pending \? 'true' : 'false'\}/);
    expect(tag).toMatch(/class:synapse-container--pending=\{pending\}/);
    expect(tag).toMatch(/class:synapse-container--failed=\{failed\}/);
    expect(tag).toMatch(/aria-label=\{ariaLabel\}/);
    const label = /const ariaLabel = \$derived\(([\s\S]*?)\);/.exec(BRAIN)?.[1] ?? '';
    expect(label).toMatch(
      /failed[\s\S]*synapse\.brain\.failed[\s\S]*pending[\s\S]*synapse\.brain\.pending/
    );
    expect(BRAIN).toMatch(/\{#if failed && !pending && !failedTipDismissed\}/);
  });
});

describe('SynapseBrain — the orb rides and collapses on the compositor', () => {
  const css = styleOf(BRAIN);

  it('never transitions `bottom`', () => {
    expect(css).not.toMatch(/transition:[^;]*\bbottom\b/);
  });

  it('the footer / cookie-sheet clearance is a translate, not part of `bottom`', () => {
    expect(css).toMatch(/translate:\s*0\s+calc\(-1 \* var\(--footer-clearance, 0px\)\)/);
    expect(css).toMatch(
      /translate:\s*0\s+calc\(-1 \* \(var\(--consent-sheet-height, 0px\) \+ var\(--footer-clearance, 0px\)\)\)/
    );
    // No `bottom:` declaration on the container may reference the clearances.
    const containerBottoms = [
      ...css.matchAll(/\.synapse-container\s*\{[^}]*?bottom:\s*([^;]+);/g),
    ].map((m) => m[1]!);
    expect(containerBottoms.length).toBeGreaterThan(0);
    for (const value of containerBottoms) {
      expect(value).not.toMatch(/--footer-clearance|--consent-sheet-height/);
    }
  });

  it('the collapse is the individual `scale` property with the spring token', () => {
    expect(css).toMatch(/\.synapse-container--collapsed\s*\{\s*scale:\s*0;/);
    expect(css).toMatch(/scale 300ms var\(--ease-spring\)/);
  });

  it('the pending pulse animates opacity only and sits behind no-preference', () => {
    const frames = keyframesOf(css);
    const pulse = frames['synapse-pending'] ?? '';
    // Mutation: animate `scale` or `box-shadow` in the pending keyframe.
    expect(pulse).toMatch(/opacity/);
    expect(pulse).not.toMatch(/scale|transform|box-shadow|bottom|width|height/);
    const gated = mediaBlocks(css, /prefers-reduced-motion:\s*no-preference/).join('\n');
    expect(gated).toMatch(/\.synapse-container--pending\s*\{[^}]*animation:\s*synapse-pending/);
    // The static cue that survives reduced motion is the cursor, written
    // inline by a directive (a class rule loses to brain-morph's inline
    // `cursor: pointer`).
    // Mutation: drop the `style:cursor` directive from the tag.
    expect(orbTag()).toMatch(
      /style:cursor=\{pending \? 'progress' : isReady \? 'pointer' : null\}/
    );
  });

  it('every animation and translate / scale transition sits behind prefers-reduced-motion: no-preference', () => {
    // Balanced-block extraction (brace-aware), not a lazy span from the
    // first @media header — HeroOverlay's guard was defeated that way.
    // Mutation: lift `.synapse-container--pending { animation: … }` out of
    // the no-preference block.
    const gated = mediaBlocks(css, /prefers-reduced-motion:\s*no-preference/).join('\n');
    let ungated = css;
    for (const block of mediaBlocks(css, /prefers-reduced-motion:\s*no-preference/)) {
      ungated = ungated.replace(block, '');
    }
    expect(gated).toMatch(/transition:[^;]*\btranslate\b/);
    expect(ungated).not.toMatch(/transition:[^;]*\b(translate|scale)\b/);
    // The only animation declarations outside the gate are the tooltip's
    // (switched off under reduce) — never the orb's own pulse.
    for (const m of ungated.matchAll(/animation:\s*([\w-]+)/g)) {
      expect(m[1]).not.toBe('synapse-pending');
    }
  });

  it('the collapse runs on phones too: the mobile block does not neutralise `scale`', () => {
    // A conscious call (see the stylesheet note): the historic
    // `transform: none !important` stays, but no `scale:` may be forced in
    // the 767px block.
    // Mutation: add `scale: 1 !important;` to the mobile .synapse-container rule.
    const mobile = mediaBlocks(css, /max-width:\s*767px/).join('\n');
    expect(mobile).toMatch(/transform:\s*none\s*!important/);
    expect(mobile).not.toMatch(/\bscale\s*:/);
  });
});

describe('SynapseSidebar — landmark semantics and the logo pulse', () => {
  const css = styleOf(SIDEBAR);

  it('the history panel is a plain named <aside>, not role="navigation"', () => {
    // `<aside\s` — the opening tag, not the `<aside>` mentioned in the comment
    // above it (comments are stripped anyway).
    const aside = /<aside\s[\s\S]*?>/.exec(SIDEBAR)?.[0] ?? '';
    expect(aside).toMatch(/aria-label=/);
    expect(aside).not.toMatch(/role=/);
  });

  it('no keyframe animates box-shadow', () => {
    const frames = keyframesOf(css);
    expect(Object.keys(frames)).toContain('logo-pulse');
    for (const [name, body] of Object.entries(frames)) {
      expect(body, `@keyframes ${name} animates box-shadow`).not.toMatch(/box-shadow/);
    }
  });

  it('both halos are pseudo-elements with static shadows that crossfade, so the peak is 14px@0.9 alone', () => {
    // The dot itself carries no shadow: a shadow on the dot would ADD to the
    // 14px halo at peak (audit 2026-09-21 — brighter than the old keyframe).
    // Mutation: put `box-shadow: 0 0 8px …` back on .sidebar-logo__dot.
    const dot = /\.sidebar-logo__dot\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dot).toMatch(/animation:\s*logo-pulse/);
    expect(dot).not.toMatch(/box-shadow/);
    expect(css).toMatch(
      /\.sidebar-logo__dot::before\s*\{[^}]*box-shadow:\s*0 0 8px hsla\(175, 100%, 50%, 0\.6\)[^}]*animation:\s*logo-rest/
    );
    expect(css).toMatch(
      /\.sidebar-logo__dot::after\s*\{[^}]*box-shadow:\s*0 0 14px hsla\(175, 100%, 50%, 0\.9\)[^}]*opacity:\s*0;[^}]*animation:\s*logo-glow/
    );
    const frames = keyframesOf(css);
    // rest halo 1 → 0 → 1, glow halo 0 → 1 → 0: never both at full.
    expect(frames['logo-rest']).toMatch(
      /0%,\s*100%\s*\{\s*opacity:\s*1;\s*\}\s*50%\s*\{\s*opacity:\s*0;/
    );
    expect(frames['logo-glow']).toMatch(
      /0%,\s*100%\s*\{\s*opacity:\s*0;\s*\}\s*50%\s*\{\s*opacity:\s*1;/
    );
    for (const name of ['logo-rest', 'logo-glow']) {
      expect(frames[name]).not.toMatch(/box-shadow|transform/);
    }
  });

  it('the pulse stops under prefers-reduced-motion for the dot and both halos', () => {
    const reduce = mediaBlocks(css, /prefers-reduced-motion:\s*reduce/).join('\n');
    expect(reduce).toMatch(
      /\.sidebar-logo__dot,\s*\.sidebar-logo__dot::before,\s*\.sidebar-logo__dot::after\s*\{\s*animation:\s*none;/
    );
  });
});

describe('SynapseTerminal — its CSS stays out of the homepage stylesheet', () => {
  it('terminal and sidebar compile their styles into the lazy chunk (css="injected")', () => {
    // Astro hoists the CSS of dynamically imported components into the
    // page; injected CSS emits no CSS module, so there is nothing to hoist.
    // Measured 2026-09-21 on /en/: inline CSS 96,250 → 71,083 B.
    // Mutation: remove `<svelte:options css="injected" />` from SynapseTerminal.
    expect(TERMINAL).toMatch(/<svelte:options css="injected" \/>/);
    expect(SIDEBAR).toMatch(/<svelte:options css="injected" \/>/);
  });
});
