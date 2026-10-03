// @ts-check
import { readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const homePaths = ['/en/', '/ru/'];
const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
export const WORKER_ROUTES = {
  version: 1,
  include: ['/api/contact', '/en', '/en/', '/ru', '/ru/'],
  exclude: [],
};

/** @typedef {{path:string, set:Record<string,string>, unset:string[]}} HeaderRule */
/** @param {string} input @returns {HeaderRule[]} */
export function parsePageHeaders(input) {
  if (Buffer.byteLength(input, 'utf8') > 256 * 1024) throw new Error('Header file exceeds budget');
  /** @type {HeaderRule[]} */
  const rules = [];
  /** @type {HeaderRule | undefined} */
  let current;
  for (const source of input.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    if (Buffer.byteLength(source, 'utf8') > 2000) throw new Error('Invalid headers');
    if (line.startsWith('/')) {
      if (
        (line.match(/\*/g) ?? []).length > 1 ||
        /[\x00-\x20:#?\\]/.test(line) ||
        rules.some((rule) => rule.path === line)
      )
        throw new Error('Invalid headers');
      current = { path: line, set: Object.create(null), unset: [] };
      rules.push(current);
    } else {
      if (!current) throw new Error('Invalid headers');
      if (line.startsWith('!')) {
        const name = line.slice(1).trim().toLowerCase();
        if (!headerName.test(name)) throw new Error('Invalid headers');
        current.unset.push(name);
      } else {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (colon < 1 || !headerName.test(name) || !value || /[\x00-\x1f\x7f]/.test(value))
          throw new Error('Invalid headers');
        current.set[name] = current.set[name] ? current.set[name] + ', ' + value : value;
      }
    }
  }
  if (!rules.length || rules.length > 100) throw new Error('Invalid headers');
  return rules;
}

/** @param {HeaderRule[]} rules @param {string} pathname @returns {Record<string,string>} */
export function resolvePageHeaders(rules, pathname) {
  /** @type {Map<string,string>} */
  const result = new Map();
  const setMap = new Set();
  for (const rule of rules) {
    const escaped = rule.path
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (!new RegExp('^' + escaped + '$').test(pathname)) continue;
    // Cloudflare unsets first. A prior set is appended only if still present.
    for (const name of rule.unset) result.delete(name);
    for (const [name, value] of Object.entries(rule.set)) {
      result.set(
        name,
        setMap.has(name) && result.has(name) ? result.get(name) + ', ' + value : value
      );
      setMap.add(name);
    }
  }
  if (!result.has('content-security-policy')) throw new Error('Missing page policy');
  return Object.fromEntries(result);
}

/** @param {string} input @returns {Record<string,Record<string,string>>} */
export function homeHeaderManifest(input) {
  const rules = parsePageHeaders(input);
  return Object.fromEntries(
    homePaths.map((path) => {
      if (!rules.some((rule) => rule.path === path)) throw new Error('Missing exact home policy');
      const headers = resolvePageHeaders(rules, path);
      if (headers['content-security-policy']?.includes(','))
        throw new Error('Ambiguous page policy');
      return [path, headers];
    })
  );
}

/** @typedef {{type:string,fileName:string,code?:string,imports?:string[],dynamicImports?:string[]}} WorkerChunk */
/** @typedef {{output:WorkerChunk[]}} WorkerBundle */
/** @param {string} output @param {string} projectRoot @returns {Promise<{bytes:number,routes:typeof WORKER_ROUTES}>} */
export async function buildPagesWorker(output, projectRoot) {
  const directory = await realpath(output);
  const headersFile = resolve(directory, '_headers');
  if ((await lstat(headersFile)).isSymbolicLink() || (await realpath(headersFile)) !== headersFile)
    throw new Error('Invalid build headers path');
  const manifest = homeHeaderManifest(await readFile(headersFile, 'utf8'));
  const fromAstro = createRequire(import.meta.resolve('astro/package.json'));
  const viteUrl = pathToFileURL(fromAstro.resolve('vite')).href;
  // Resolve Astro's installed bundler; no extra package or application config.
  const vite = await import(viteUrl);
  if (typeof vite.build !== 'function') throw new Error('Installed bundler unavailable');
  const entryId = 'virtual:vkv-pages-worker';
  const resolvedEntry = '\0' + entryId;
  const source =
    'import { createSiteWorker } from ' +
    JSON.stringify(resolve(projectRoot, 'functions/_lib/site-worker.ts').replaceAll('\\', '/')) +
    ';\nexport default createSiteWorker(' +
    JSON.stringify(manifest) +
    ');';
  /** @type {WorkerBundle | WorkerBundle[]} */
  const built = await vite.build({
    root: projectRoot,
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'vkv-pages-worker-entry',
        resolveId(/** @type {string} */ id) {
          return id === entryId ? resolvedEntry : null;
        },
        load(/** @type {string} */ id) {
          return id === resolvedEntry ? source : null;
        },
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      sourcemap: false,
      minify: true,
      target: 'es2022',
      lib: { entry: entryId, formats: ['es'], fileName: () => '_worker.js' },
      // Explicit input preserves the virtual ID before Vite normalizes lib.entry.
      rolldownOptions: { input: entryId, output: { codeSplitting: false } },
    },
  });
  const chunks = (Array.isArray(built) ? built : [built]).flatMap((bundle) => bundle.output);
  const worker = chunks[0];
  if (
    chunks.length !== 1 ||
    !worker ||
    worker.type !== 'chunk' ||
    worker.fileName !== '_worker.js' ||
    typeof worker.code !== 'string' ||
    worker.imports?.length ||
    worker.dynamicImports?.length
  )
    throw new Error('Worker must be one self-contained ES module');
  if (
    Buffer.byteLength(worker.code, 'utf8') > 1024 * 1024 ||
    /[\\/]\.system[\\/]|sourceMappingURL/.test(worker.code)
  )
    throw new Error('Invalid worker output');
  await writeFile(resolve(directory, '_worker.js'), worker.code, { encoding: 'utf8', flag: 'wx' });
  await writeFile(
    resolve(directory, '_routes.json'),
    JSON.stringify(WORKER_ROUTES, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx' }
  );
  return { bytes: Buffer.byteLength(worker.code, 'utf8'), routes: WORKER_ROUTES };
}

/** @returns {import('astro').AstroIntegration} */
export default function pagesWorker() {
  let projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  return {
    name: 'vkv-pages-worker',
    hooks: {
      'astro:config:done': ({ config }) => {
        projectRoot = fileURLToPath(config.root);
      },
      'astro:build:done': async ({ dir, logger }) => {
        const result = await buildPagesWorker(fileURLToPath(dir), projectRoot);
        logger.info(
          'Built isolated Pages worker (' + result.bytes + ' bytes) for five exact routes.'
        );
      },
    },
  };
}
