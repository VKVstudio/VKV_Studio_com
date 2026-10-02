/** Open only after the owner approves the public .pro launch and destination. */
export const PRO_PROMO_LAUNCHED: boolean = false;

interface ProPromoOptions {
  launched: boolean;
  isDev: boolean;
  previewBuild: boolean;
  localPreviewUrl?: string;
}

/** Only the separately opted-in loopback preview is a pre-launch destination. */
export function resolveLocalProPreview(value?: string): string | null {
  return value === 'http://127.0.0.1:4323/' ? value : null;
}

export function resolveProPromo({
  launched,
  isDev,
  previewBuild,
  localPreviewUrl,
}: ProPromoOptions): { visible: boolean; href: string | null } {
  return {
    visible: launched || isDev || previewBuild,
    href: launched
      ? 'https://vkvstudio.pro/'
      : isDev || previewBuild
        ? resolveLocalProPreview(localPreviewUrl)
        : null,
  };
}
