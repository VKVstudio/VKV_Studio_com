import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { addSubresourceIntegrity } from '../../src/build/subresource-integrity.mjs';

const scripts = 'console.log("public fixture");';
const css = 'body { color: black; }';
const expected = (value: string) => 'sha384-' + createHash('sha384').update(value).digest('base64');
async function fixture(html: string) {
  const base = resolve(tmpdir(), 'vkvstudio-sri-fixtures');
  await mkdir(base, { recursive: true });
  const folder = await mkdtemp(resolve(base, 'case-'));
  await mkdir(resolve(folder, 'assets'));
  await writeFile(resolve(folder, 'assets/app.js'), scripts);
  await writeFile(resolve(folder, 'assets/site.css'), css);
  await writeFile(resolve(folder, 'index.html'), html);
  return folder;
}

describe('generated script and stylesheet integrity', () => {
  it('protects exact bytes and preserves inline script content and comments', async () => {
    const inline = '<script>const markup = "<script src=\\"not-an-asset.js\\">";</script>';
    const comment = '<!-- <script src="ignored.js"></script> -->';
    const root = await fixture('<html><head><link rel="stylesheet" href="/assets/site.css"></head><body>'
      + inline + comment + '<script type="module" src="/assets/app.js" crossorigin></script></body></html>');
    const proof = await addSubresourceIntegrity(root);
    expect(proof).toEqual({ htmlPages: 1, protectedReferences: 2, uniqueAssets: 2, externalReferences: 0 });
    const html = await readFile(resolve(root, 'index.html'), 'utf8');
    expect(html).toContain(inline); expect(html).toContain(comment);
    expect(html).toContain(`integrity="${expected(scripts)}"`);
    expect(html).toContain(`integrity="${expected(css)}"`);
    expect(html.match(/crossorigin/g)).toHaveLength(2);
    await addSubresourceIntegrity(root);
    expect(await readFile(resolve(root, 'index.html'), 'utf8')).toBe(html);
  });

  it('detects changed asset bytes instead of preserving a stale integrity claim', async () => {
    const root = await fixture('<script src="/assets/app.js"></script>');
    await addSubresourceIntegrity(root);
    await writeFile(resolve(root, 'assets/app.js'), scripts + '// changed');
    await expect(addSubresourceIntegrity(root)).rejects.toThrow('Stale asset integrity');
  });

  it('does not invent hashes for rotating external SDKs or inline scripts', async () => {
    const original = '<script src="https://accounts.google.com/gsi/client"></script><script>const x = 1;</script>';
    const root = await fixture(original);
    const proof = await addSubresourceIntegrity(root);
    expect(proof.externalReferences).toBe(1); expect(proof.protectedReferences).toBe(0);
    expect(await readFile(resolve(root, 'index.html'), 'utf8')).toBe(original);
  });

  it.each(['../outside.js', '/assets/app.js?other', '/assets/%61pp.js'])('rejects ambiguous/outside path %s', async (url) => {
    const root = await fixture(`<script src="${url}"></script>`);
    await expect(addSubresourceIntegrity(root)).rejects.toThrow();
  });

  it('refuses a missing referenced asset without partially rewriting HTML', async () => {
    const original = '<script src="/assets/app.js"></script><script src="/missing.js"></script>';
    const root = await fixture(original);
    await expect(addSubresourceIntegrity(root)).rejects.toThrow();
    expect(await readFile(resolve(root, 'index.html'), 'utf8')).toBe(original);
  });

  it('handles local unquoted assets and self-closing stylesheet links', async () => {
    const root = await fixture('<script src=/assets/app.js></script><link rel="stylesheet" href="assets/site.css"/>');
    const proof = await addSubresourceIntegrity(root);
    expect(proof.protectedReferences).toBe(2);
    expect(await readFile(resolve(root, 'index.html'), 'utf8')).toContain('crossorigin="anonymous"/>');
  });
});
