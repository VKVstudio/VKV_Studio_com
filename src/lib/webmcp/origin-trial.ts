/**
 * The Chrome Origin Trial token for WebMCP.
 *
 * EMPTY UNTIL THE OWNER REGISTERS. While it is empty, BaseLayout emits no meta
 * tag at all and `document.modelContext` simply does not exist for visitors —
 * every tool in this folder stays dormant and costs nothing. That is the
 * intended resting state, not a broken one.
 *
 * To activate: register at https://developer.chrome.com/origintrials (free,
 * no approval, Google sign-in required), origin https://vkvstudio.com with
 * "match all subdomains" ticked so the apex and www share one token. Paste the
 * token below. Full walkthrough: .system/ORIGIN-TRIAL-HOWTO.md
 *
 * The token is NOT a secret and belongs in the repository: it encodes only the
 * origin, the feature name and an expiry date — no account id, no address. It
 * is served in public HTML by design.
 *
 * WHY THE EXPIRY GUARD EXISTS: Chrome ignores an expired token in COMPLETE
 * SILENCE — no console warning, no failed request, no Lighthouse audit. The
 * only in-browser signal is DevTools → Application → Frames → Origin Trials.
 * HTTP Archive found 17% of first-party sites serving dead tokens without
 * knowing. So tests/unit/webmcp-origin-trial.test.ts decodes the payload and
 * FAILS the suite once expiry is less than 14 days out. The trial itself runs
 * to 17 November 2026 (Chrome 149–156); renewal means a rebuild and a redeploy,
 * not a settings change.
 */

/**
 * Registered 2026-09-20 for https://vkvstudio.com with subdomain matching, so
 * the apex and www share this one token. Expires 2026-11-17, when the trial
 * itself ends (Chrome 149–156).
 */
export const ORIGIN_TRIAL_TOKEN =
  'AmpqvuGH5D6sqJDwQSvdHfEr/lXBW7OBw6kiNFojgCvg43/2U0Uu9CHz2s53L772+Gbn0dE502GHZpDanjKxogQAAABgeyJvcmlnaW4iOiJodHRwczovL3ZrdnN0dWRpby5jb206NDQzIiwiZmVhdHVyZSI6IldlYk1DUCIsImV4cGlyeSI6MTc5NDg3MzYwMCwiaXNTdWJkb21haW4iOnRydWV9';

/** Days of runway the expiry test demands before it starts failing the build. */
export const RENEWAL_WARNING_DAYS = 14;

export interface OriginTrialPayload {
  origin: string;
  feature: string;
  /** Seconds since the Unix epoch, as Chrome encodes it. */
  expiry: number;
  isSubdomain?: boolean;
}

/**
 * Decodes a token's payload. Chrome's format: 1 byte version, 64 bytes Ed25519
 * signature, 4 bytes big-endian payload length, then the JSON payload.
 * Returns null for anything that is not a well-formed token — the caller
 * decides whether that is a failure or simply "not configured yet".
 */
export function decodeOriginTrialToken(token: string): OriginTrialPayload | null {
  if (!token) return null;
  try {
    const raw = atob(token);
    if (raw.length < 69) return null;
    const length =
      (raw.charCodeAt(65) << 24) |
      (raw.charCodeAt(66) << 16) |
      (raw.charCodeAt(67) << 8) |
      raw.charCodeAt(68);
    const json = raw.slice(69, 69 + length);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['origin'] !== 'string' || typeof p['feature'] !== 'string') return null;
    if (typeof p['expiry'] !== 'number') return null;
    return {
      origin: p['origin'],
      feature: p['feature'],
      expiry: p['expiry'],
      ...(typeof p['isSubdomain'] === 'boolean' ? { isSubdomain: p['isSubdomain'] } : {}),
    };
  } catch {
    return null;
  }
}
