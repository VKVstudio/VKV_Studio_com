import { describe, expect, it } from 'vitest';
import { PRO_PROMO_LAUNCHED, resolveProPromo } from '../../src/lib/pro-promo';

describe('VKVstudio.pro public launch gate', () => {
  it('keeps the unapproved public destination closed', () => {
    expect(PRO_PROMO_LAUNCHED).toBe(false);
  });

  it('omits the promo from a normal production build before launch', () => {
    expect(resolveProPromo({ launched: false, isDev: false, previewBuild: false })).toEqual({
      visible: false,
      href: null,
    });
  });

  it.each([
    { isDev: true, previewBuild: false },
    { isDev: false, previewBuild: true },
    { isDev: true, previewBuild: true },
  ])('shows a preview without permitting external navigation: %j', (preview) => {
    expect(resolveProPromo({ launched: false, ...preview })).toEqual({
      visible: true,
      href: null,
    });
  });

  it('provides the public link only after explicit launch', () => {
    expect(resolveProPromo({ launched: true, isDev: false, previewBuild: false })).toEqual({
      visible: true,
      href: 'https://vkvstudio.pro/',
    });
  });
});

describe('explicit loopback preview', () => {
  it('navigates locally only with both preview opt-ins', () => {
    const opts = {
      launched: false,
      isDev: false,
      previewBuild: true,
      localPreviewUrl: 'http://127.0.0.1:4323/',
    };
    expect(resolveProPromo(opts).href).toBe(opts.localPreviewUrl);
    expect(resolveProPromo({ ...opts, previewBuild: false })).toEqual({
      visible: false,
      href: null,
    });
  });
  it.each([
    'https://vkvstudio.pro/',
    'http://0.0.0.0:4323/',
    'http://127.0.0.1:4323/evil',
    'http://127.0.0.1:4323/?x=1',
    'http://localhost:4323/',
    'http://evil@127.0.0.1:4323/',
  ])('rejects other destinations: %s', (localPreviewUrl) => {
    expect(
      resolveProPromo({ launched: false, isDev: true, previewBuild: true, localPreviewUrl }).href
    ).toBeNull();
  });
});
