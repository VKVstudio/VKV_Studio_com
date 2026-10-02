import { describe, it, expect } from 'vitest';
import { PRO_INSIGHTS, resolveProReading } from '../../src/lib/pro-insights';
describe('scoped editorial crosslinks', () => {
  it('production exposes no link before individual destination acceptance', () => {
    for (const id of Object.keys(PRO_INSIGHTS) as (keyof typeof PRO_INSIGHTS)[]) {
      const reading = resolveProReading(id, { isDev: false, previewBuild: false });
      expect(reading.visible).toBe(false);
      expect(reading.href).toBeNull();
      expect(
        resolveProReading(id, { isDev: false, previewBuild: false, launched: true }).href
      ).toBeNull();
    }
  });
  it('local preview explains pending editorial content without a dead href', () => {
    for (const id of Object.keys(PRO_INSIGHTS) as (keyof typeof PRO_INSIGHTS)[]) {
      const reading = resolveProReading(id, { isDev: true, previewBuild: false });
      expect(reading.visible).toBe(true);
      expect(reading.href).toBeNull();
    }
    expect(PRO_INSIGHTS.ragComparison.path).toBeNull();
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
  expect(resolveProReading('ragComparison', opts).href).toBeNull();
  expect(resolveProReading('home', { ...opts, previewBuild: false }).href).toBeNull();
  expect(
    resolveProReading('home', { ...opts, localPreviewUrl: 'https://evil.test/' }).href
  ).toBeNull();
});
