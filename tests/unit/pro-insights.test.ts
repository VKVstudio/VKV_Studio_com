import { describe, it, expect } from 'vitest';
import { PRO_INSIGHTS, resolveProReading } from '../../src/lib/pro-insights';
describe('scoped editorial crosslinks', () => {
  it('production exposes all accepted public destinations', () => {
    for (const id of Object.keys(PRO_INSIGHTS) as (keyof typeof PRO_INSIGHTS)[]) {
      const reading = resolveProReading(id, { isDev: false, previewBuild: false });
      expect(reading.visible).toBe(true);
      expect(reading.href).toBe('https://vkvstudio.pro' + PRO_INSIGHTS[id].path);
      expect(
        resolveProReading(id, { isDev: false, previewBuild: false, launched: true }).href
      ).toBe('https://vkvstudio.pro' + PRO_INSIGHTS[id].path);
    }
  });
  it('development keeps released destinations usable without a configured local origin', () => {
    for (const id of Object.keys(PRO_INSIGHTS) as (keyof typeof PRO_INSIGHTS)[]) {
      const reading = resolveProReading(id, { isDev: true, previewBuild: false });
      expect(reading.visible).toBe(true);
      expect(reading.href).toBe('https://vkvstudio.pro' + PRO_INSIGHTS[id].path);
    }
    expect(PRO_INSIGHTS.ragComparison.path).toBe('/briefings/');
  });
});

it('opens only implemented local routes in explicitly configured preview', () => {
  const opts = { isDev: false, previewBuild: true, localPreviewUrl: 'http://127.0.0.1:4323/' };
  expect(resolveProReading('home', opts).href).toBe(opts.localPreviewUrl);
  expect(resolveProReading('geoGuide', opts).href).toBe(
    opts.localPreviewUrl + 'briefings/ai-search-no-magic-file/'
  );
  expect(resolveProReading('localModel', opts).href).toBe(
    opts.localPreviewUrl + 'briefings/nemotron-active-parameters-are-not-memory/'
  );
  expect(resolveProReading('ragComparison', opts).href).toBe(opts.localPreviewUrl + 'briefings/');
  expect(resolveProReading('home', { ...opts, previewBuild: false }).href).toBe('https://vkvstudio.pro/');
  expect(
    resolveProReading('home', { ...opts, localPreviewUrl: 'https://evil.test/' }).href
  ).toBe('https://vkvstudio.pro/');
});
