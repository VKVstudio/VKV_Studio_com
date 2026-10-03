/** Open only after the owner approves the public .pro launch and destination. */
export const PRO_PROMO_LAUNCHED: boolean = true;

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
    visible: true,
    href:
      ((isDev || previewBuild) && resolveLocalProPreview(localPreviewUrl)) ||
      (launched ? 'https://vkvstudio.pro/' : null),
  };
}
