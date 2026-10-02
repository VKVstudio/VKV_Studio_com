import { afterEach, expect, it, vi } from 'vitest';
import { registerSiteTools } from '@/lib/webmcp/register';
import { buildTools } from '@/lib/webmcp/tools';

afterEach(() => { vi.unstubAllGlobals(); });

it('keeps a browser without native WebMCP usable', async () => {
  vi.stubGlobal('document', {});
  expect(await registerSiteTools('en')).toBe(0);
});

it('counts only resolved native registrations and continues after asynchronous rejection', async () => {
  const count = buildTools('en').length;
  let attempted = 0;
  const registerTool = vi.fn(async () => {
    attempted += 1;
    await Promise.resolve();
    if (attempted < count) throw new Error('Native policy rejected this tool');
  });
  vi.stubGlobal('document', { modelContext: { registerTool } });
  expect(await registerSiteTools('en')).toBe(1);
  expect(registerTool).toHaveBeenCalledTimes(count);
});

it('isolates synchronous native failures and leaves remaining tools available', async () => {
  let attempted = 0;
  const registerTool = vi.fn(() => {
    attempted += 1;
    if (attempted === 1) throw new Error('Unsupported native shape');
  });
  vi.stubGlobal('document', { modelContext: { registerTool } });
  expect(await registerSiteTools('ru')).toBe(buildTools('ru').length - 1);
});
