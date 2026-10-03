import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (body) => 'sha384-' + createHash('sha384').update(body).digest('base64');
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
};

/** Add byte-exact integrity to local entry scripts and stylesheets, not dynamic imports. */
export async function addSubresourceIntegrity(directory) {
  const root = await realpath(directory);
  const pages = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink in generated output');
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.html')) pages.push(path);
    }
  }
  await visit(root);
  const hashes = new Map();
  const changes = [];
  let protectedReferences = 0;
  let externalReferences = 0;
  for (const page of pages) {
    const before = await readFile(page, 'utf8');
    const tokens = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi;
    let after = '', cursor = 0;
    for (const match of before.matchAll(tokens)) {
      const token = match[0];
      after += before.slice(cursor, match.index);
      cursor = match.index + token.length;
      if (token.startsWith('<!--')) { after += token; continue; }
      const opening = token.slice(0, token.indexOf('>') + 1);
      const attrs = new Map();
      for (const attr of opening.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const name = attr[1].toLowerCase();
        if (attrs.has(name)) throw new Error('Duplicate generated asset attribute');
        attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      const script = /^<script\b/i.test(opening);
      const url = script ? attrs.get('src') : attrs.get('rel') === 'stylesheet' ? attrs.get('href') : undefined;
      if (!url) { after += token; continue; }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
        externalReferences++; after += token; continue;
      }
      // Build-generated URLs must be literal local paths; queries and escaped paths are ambiguous.
      if (/[?#&%\\\x00-\x20]/.test(url)) throw new Error('Unsupported generated asset URL');
      const asset = resolve(url.startsWith('/') ? root : dirname(page), url.replace(/^\//, ''));
      if (!inside(root, asset) || !inside(root, await realpath(asset)) || !(await lstat(asset)).isFile()) {
        throw new Error('Asset outside generated output');
      }
      if (!hashes.has(asset)) hashes.set(asset, digest(await readFile(asset)));
      const integrity = hashes.get(asset);
      if (attrs.has('integrity') && attrs.get('integrity') !== integrity) throw new Error('Stale asset integrity');
      if (attrs.has('crossorigin') && !['', 'anonymous'].includes(attrs.get('crossorigin'))) throw new Error('Credentialed static asset');
      const extra = (attrs.has('integrity') ? '' : ` integrity="${integrity}"`)
        + (attrs.has('crossorigin') ? '' : ' crossorigin="anonymous"');
      const close = opening.endsWith('/>') ? opening.length - 2 : opening.length - 1;
      after += opening.slice(0, close) + extra + opening.slice(close) + token.slice(opening.length);
      protectedReferences++;
    }
    after += before.slice(cursor);
    changes.push({ page, before, after });
  }
  // Validate every reference before changing any generated page; never edit sources.
  for (const { page, before, after } of changes) {
    if (await readFile(page, 'utf8') !== before) throw new Error('Generated HTML changed during integrity pass');
    if (after !== before) await writeFile(page, after);
  }
  return { htmlPages: pages.length, protectedReferences, uniqueAssets: hashes.size, externalReferences };
}

export default function subresourceIntegrity() {
  return { name: 'vkv-subresource-integrity', hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const result = await addSubresourceIntegrity(fileURLToPath(dir));
      logger.info(`SRI: ${result.protectedReferences} local script/style references in ${result.htmlPages} pages`);
    },
  } };
}
