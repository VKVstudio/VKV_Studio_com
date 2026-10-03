// @ts-check
/**
 * Build-only CSP generation. Nothing from this module enters a browser bundle.
 * Keep SSR and Svelte hydration unchanged; admit exact, reviewed style bytes.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CSP_HEADER = 'Content-Security-Policy';
const HASH_TOKEN = /^'sha(?:256|384|512)-[^']+'$/;
const MAX_LINE_BYTES = 2000;
const MAX_RULES = 100;
const ORIGIN = 'https://vkvstudio.com';

/** @typedef {{ inlineScripts: string[], inlineStyles: string[], styleAttributes: string[], modules: string[] }} HtmlPolicyInput */
/** @typedef {{ imports: string[], inlineStyles: string[], styleAttributes: string[] }} ModulePolicyInput */
/** @typedef {{ route: string, styles: string[], attributes: string[] }} PagePolicyInput */
/** @typedef {{ headers: string, policies: {route: string, policy: string}[], longestLineBytes: number }} GeneratedPolicy */

/** @param {string} value @returns {string} */
export function cspHash(value) {
  return "'sha256-" + createHash('sha256').update(value, 'utf8').digest('base64') + "'";
}

/** HTML attribute entities are decoded before the browser hashes their value.
 * @param {string} value @returns {string}
 */
function attributeValue(value) {
  /** @param {string} match @param {string} entity @returns {string} */
  function replaceEntity(match, entity) {
    /** @type {Record<string, string>} */
    const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code =
      entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
    if (
      !Number.isInteger(code) ||
      code < 1 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new Error('Invalid character reference in generated attribute');
    }
    return String.fromCodePoint(code);
  }
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|quot|apos|lt|gt);/gi, replaceEntity);
}

/** @param {string} html @param {string} name @returns {string[]} */
function attributes(html, name) {
  const pattern = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'gi');
  return [...html.matchAll(pattern)].map((match) =>
    attributeValue(match[1] ?? match[2] ?? match[3] ?? '')
  );
}

/** Restrict hash permissions to finite, non-network style declarations.
 * Dynamic styles remain trusted CSSOM writes, not permissions for arbitrary markup.
 * @param {string} value @returns {void}
 */
export function assertSafeStyleAttribute(value) {
  if (
    typeof value !== 'string' ||
    value.length > 400 ||
    /[\x00-\x1f\x7f<>@\\]|url\s*\(|expression\s*\(|!important/i.test(value)
  ) {
    throw new Error('Unsafe generated style attribute');
  }
  const numeric = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const length = numeric + '(?:px|%|rem)?';
  /** @type {Record<string, RegExp>} */
  const allowed = {
    opacity: new RegExp('^' + numeric + '$'),
    visibility: /^(?:hidden|visible)$/,
    transform: new RegExp(
      '^(?:(?:translate(?:X|Y)?|scale)\\(\\s*' +
        length +
        '(?:\\s*,\\s*' +
        length +
        ')?\\s*\\)\\s*)+$'
    ),
    cursor: /^(?:pointer|progress|default)$/,
    width: new RegExp('^' + length + '$'),
    height: new RegExp('^' + length + '$'),
    left: new RegExp('^' + length + '$'),
    top: new RegExp('^' + length + '$'),
    position: /^relative$/,
    'font-family': /^var\(--font-mono\)$/,
    'font-size': /^var\(--text-(?:sm|xs)\)$/,
    'text-transform': /^uppercase$/,
    color: /^var\(--text-muted\)$/,
    padding: /^var\(--space-4\)$/,
    '--fill-index': /^-?\d+$/,
  };
  const declarations = value.split(';').filter((part) => part.trim());
  if (declarations.length === 0) throw new Error('Empty generated style attribute');
  for (const part of declarations) {
    const colon = part.indexOf(':');
    const property = part.slice(0, colon).trim();
    const content = part.slice(colon + 1).trim();
    if (colon < 1 || !Object.hasOwn(allowed, property) || !allowed[property]?.test(content)) {
      throw new Error('Unreviewed generated style declaration: ' + property);
    }
  }
}

/** @param {string} html @returns {HtmlPolicyInput} */
export function inspectHtml(html) {
  const inlineScripts = [];
  const modules = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    const sources = attributes(attrs, 'src');
    if (sources.length) modules.push(...sources);
    else if (!/\btype\s*=\s*["']application\/(?:ld\+json|json)["']/i.test(attrs))
      inlineScripts.push(match[2] ?? '');
  }
  modules.push(...attributes(html, 'component-url'), ...attributes(html, 'renderer-url'));
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (match) => match[1] ?? ''
  );
  const styleAttributes = attributes(html, 'style');
  styleAttributes.forEach(assertSafeStyleAttribute);
  return { inlineScripts, inlineStyles, styleAttributes, modules };
}

/** Parse emitted JavaScript without importing or executing it.
 * Capture Svelte's injected CSS objects and literal HTML templates, including lazy modules.
 * @param {string} source @returns {ModulePolicyInput}
 */
export function inspectModule(source) {
  /** @type {Set<string>} */
  const imports = new Set();
  /** @type {Set<string>} */
  const inlineStyles = new Set();
  /** @type {Set<string>} */
  const styleAttributes = new Set();
  const parsed = ts.createSourceFile(
    'generated.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  /** @param {import('typescript').Node} node @returns {void} */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.add(node.arguments[0].text);
    }
    if (ts.isObjectLiteralExpression(node)) {
      /** @type {Map<string, string>} */
      const properties = new Map();
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          (ts.isStringLiteral(property.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(property.initializer))
        ) {
          properties.set(property.name.text, property.initializer.text);
        }
      }
      const code = properties.get('code');
      if (/^svelte-[a-z0-9]+$/.test(properties.get('hash') ?? '') && code !== undefined)
        inlineStyles.add(code);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.includes('<') && /\sstyle\s*=/.test(node.text)) {
        for (const value of attributes(node.text, 'style')) {
          assertSafeStyleAttribute(value);
          styleAttributes.add(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return {
    imports: [...imports],
    inlineStyles: [...inlineStyles],
    styleAttributes: [...styleAttributes],
  };
}

/** @param {string} template @returns {Map<string, string[]>} */
function baseDirectives(template) {
  const values = [...template.matchAll(/^\s+Content-Security-Policy:\s*(.+)$/gim)];
  if (values.length !== 1) throw new Error('Expected one CSP template');
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const part of (values[0]?.[1] ?? '').split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/);
    if (!name || out.has(name)) throw new Error('Invalid CSP directive');
    if (tokens.includes("'unsafe-inline'") || tokens.includes("'unsafe-eval'"))
      throw new Error('Unsafe CSP template');
    out.set(
      name,
      tokens.filter((token) => !HASH_TOKEN.test(token))
    );
  }
  for (const name of ['script-src', 'style-src', 'style-src-elem', 'style-src-attr']) {
    if (!out.has(name)) throw new Error('Missing CSP template directive: ' + name);
  }
  return out;
}

/** @param {Map<string, string[]>} base @param {string[]} scripts @param {string[]} styles @param {string[]} attrs @returns {string} */
function policyValue(base, scripts, styles, attrs) {
  const next = new Map(base);
  next.set('script-src', [...(base.get('script-src') ?? []), ...new Set(scripts.map(cspHash))]);
  next.set('style-src-elem', [
    ...(base.get('style-src-elem') ?? []).filter((token) => token !== "'none'"),
    ...new Set(styles.map(cspHash)),
  ]);
  next.set(
    'style-src-attr',
    attrs.length ? ["'unsafe-hashes'", ...new Set(attrs.map(cspHash))] : ["'none'"]
  );
  return [...next].map(([name, tokens]) => name + ' ' + tokens.join(' ')).join('; ');
}

/** @param {string} template @param {string[]} scripts @param {PagePolicyInput[]} pages @returns {GeneratedPolicy} */
export function generateHeaders(template, scripts, pages) {
  if (!pages.length) throw new Error('No generated pages for CSP');
  /** @type {Set<string>} */
  const pageRoutes = new Set();
  for (const page of pages) {
    if (
      !page.route.startsWith('/') ||
      page.route.startsWith('//') ||
      /[\x00-\x20:*?#\\]/.test(page.route) ||
      new URL(page.route, ORIGIN).pathname !== page.route ||
      pageRoutes.has(page.route)
    ) {
      throw new Error('Invalid or duplicate CSP route');
    }
    pageRoutes.add(page.route);
    page.attributes.forEach(assertSafeStyleAttribute);
  }
  const base = baseDirectives(template);
  const fallbackPages = pages.filter((page) => page.route === '/' || page.route === '/404.html');
  if (!fallbackPages.some((page) => page.route === '/404.html'))
    throw new Error('A 404 fallback policy is required');
  const fallback = policyValue(
    base,
    scripts,
    fallbackPages.flatMap((page) => page.styles),
    fallbackPages.flatMap((page) => page.attributes)
  );
  const policies = [{ route: '/*', policy: fallback }];
  let headers = template.replace(
    /^\s+Content-Security-Policy:\s*.+$/im,
    '  ' + CSP_HEADER + ': ' + fallback
  );
  headers +=
    '\n# Generated per-page style permissions. Unset prevents Cloudflare AND-merging policies.\n';
  /** @type {Set<string>} */
  const routes = new Set();
  for (const page of pages) {
    if (page.route === '/' || page.route === '/404.html') continue;
    if (
      !page.route.startsWith('/') ||
      /[\x00-\x20:*?#\\]/.test(page.route) ||
      routes.has(page.route)
    )
      throw new Error('Invalid or duplicate CSP route');
    const policy = policyValue(base, scripts, page.styles, page.attributes);
    for (const route of [
      page.route,
      ...(page.route.endsWith('/') ? [page.route.slice(0, -1)] : []),
    ]) {
      if (routes.has(route)) throw new Error('Overlapping CSP route');
      routes.add(route);
      headers += route + '\n  ! ' + CSP_HEADER + '\n  ' + CSP_HEADER + ': ' + policy + '\n';
      policies.push({ route, policy });
    }
  }
  const lines = headers
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  const longestLineBytes = Math.max(...lines.map((line) => Buffer.byteLength(line, 'utf8')));
  const ruleCount = lines.filter((line) => line.startsWith('/')).length;
  if (longestLineBytes > MAX_LINE_BYTES)
    throw new Error('Cloudflare header line exceeds 2000 bytes: ' + longestLineBytes);
  if (ruleCount > MAX_RULES) throw new Error('Cloudflare header rules exceed 100: ' + ruleCount);
  return { headers, policies, longestLineBytes };
}

/** @param {string} root @param {string} file @returns {Promise<string>} */
async function confinedFile(root, file) {
  const target = await realpath(resolve(root, file));
  const fromRoot = relative(root, target);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep))
    throw new Error('Generated file escapes build output');
  return target;
}

/** @param {string} root @param {string} directory @returns {Promise<string[]>} */
async function htmlFiles(root, directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in build output');
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await htmlFiles(root, target)));
    else if (entry.isFile() && extname(entry.name) === '.html')
      found.push(relative(root, target).split(sep).join('/'));
  }
  return found.sort();
}

/** @param {string} url @param {string} importer @returns {string | null} */
function modulePath(url, importer) {
  const resolved = new URL(url, ORIGIN + '/' + importer);
  if (
    resolved.origin !== ORIGIN ||
    !resolved.pathname.startsWith('/_astro/') ||
    !resolved.pathname.endsWith('.js')
  )
    return null;
  if (resolved.search || resolved.hash || /%2f|%5c|%00/i.test(resolved.pathname))
    throw new Error('Invalid generated module URL');
  return decodeURIComponent(resolved.pathname).slice(1);
}

/** @param {string} output @returns {Promise<GeneratedPolicy>} */
export async function generateBuildCsp(output) {
  const root = await realpath(output);
  const headersFile = await confinedFile(root, '_headers');
  const template = await readFile(headersFile, 'utf8');
  /** @type {Map<string, ModulePolicyInput>} */
  const cache = new Map();
  /** @param {string[]} entries @param {string} page @returns {Promise<ModulePolicyInput>} */
  async function moduleGraph(entries, page) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const inlineStyles = new Set();
    /** @type {Set<string>} */
    const styleAttributes = new Set();
    const pending = entries.map((url) => modulePath(url, page)).filter((url) => url !== null);
    while (pending.length) {
      const entry = pending.pop();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      if (seen.size > 400) throw new Error('Generated module graph exceeds budget');
      let module = cache.get(entry);
      if (!module) {
        const source = await readFile(await confinedFile(root, entry), 'utf8');
        if (Buffer.byteLength(source, 'utf8') > 16 * 1024 * 1024)
          throw new Error('Generated module exceeds size budget');
        module = inspectModule(source);
        cache.set(entry, module);
      }
      module.inlineStyles.forEach((value) => inlineStyles.add(value));
      module.styleAttributes.forEach((value) => styleAttributes.add(value));
      for (const url of module.imports) {
        const next = modulePath(url, entry);
        if (next) pending.push(next);
      }
    }
    return { imports: [], inlineStyles: [...inlineStyles], styleAttributes: [...styleAttributes] };
  }
  /** @type {PagePolicyInput[]} */
  const pages = [];
  /** @type {Set<string>} */
  const scripts = new Set();
  for (const file of await htmlFiles(root, root)) {
    const html = inspectHtml(await readFile(await confinedFile(root, file), 'utf8'));
    const modules = await moduleGraph(html.modules, file);
    html.inlineScripts.forEach((value) => scripts.add(value));
    const route =
      file === 'index.html'
        ? '/'
        : file.endsWith('/index.html')
          ? '/' + file.slice(0, -10)
          : '/' + file;
    pages.push({
      route,
      styles: [...html.inlineStyles, ...modules.inlineStyles],
      attributes: [...html.styleAttributes, ...modules.styleAttributes],
    });
  }
  const generated = generateHeaders(template, [...scripts], pages);
  // This file is the newly copied build output. The public template stays unchanged.
  await writeFile(headersFile, generated.headers, 'utf8');
  return generated;
}

/** @returns {import('astro').AstroIntegration} */
export default function contentSecurityPolicy() {
  return {
    name: 'vkv-build-csp',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const generated = await generateBuildCsp(fileURLToPath(dir));
        logger.info(
          'Generated exact style CSP for ' +
            generated.policies.length +
            ' paths; longest header line ' +
            generated.longestLineBytes +
            '/2000 bytes.'
        );
      },
    },
  };
}
