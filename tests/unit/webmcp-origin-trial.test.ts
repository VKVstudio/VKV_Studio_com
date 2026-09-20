/**
 * The origin-trial token's expiry guard.
 *
 * Chrome ignores an expired origin-trial token in COMPLETE SILENCE: no
 * console warning, no failed request, no Lighthouse audit, no visible
 * breakage. The page simply stops having the feature and the meta tag becomes
 * dead weight nobody notices. HTTP Archive found 17% of first-party sites
 * serving dead tokens for exactly this reason.
 *
 * So the suite is the alarm. While no token is configured these tests assert
 * the dormant state is coherent; the moment a token exists they assert it is
 * for the right origin, the right feature, and has more than two weeks of
 * runway. Renewal means a rebuild and a redeploy, so two weeks is the notice
 * period, not a courtesy.
 */

import { describe, it, expect } from 'vitest';
import {
  ORIGIN_TRIAL_TOKEN,
  RENEWAL_WARNING_DAYS,
  decodeOriginTrialToken,
} from '@/lib/webmcp/origin-trial';

const DAY_MS = 86_400_000;

describe('WebMCP origin trial token', () => {
  it('decodes nothing from an empty or malformed token', () => {
    expect(decodeOriginTrialToken('')).toBeNull();
    expect(decodeOriginTrialToken('not-a-token')).toBeNull();
    // Well-formed base64, but far too short to carry a signature and payload.
    expect(decodeOriginTrialToken(btoa('short'))).toBeNull();
  });

  it('decodes a well-formed token', () => {
    // Built to Chrome's layout: 1 version byte, 64 signature bytes, a 4-byte
    // big-endian length, then the JSON payload. Constructing it here proves
    // the decoder reads the real format rather than a shape invented to pass.
    const payload = JSON.stringify({
      origin: 'https://vkvstudio.com:443',
      feature: 'WebMCP',
      expiry: 1_795_000_000,
      isSubdomain: true,
    });
    const header = [
      String.fromCharCode(3),
      'x'.repeat(64),
      String.fromCharCode(
        (payload.length >> 24) & 0xff,
        (payload.length >> 16) & 0xff,
        (payload.length >> 8) & 0xff,
        payload.length & 0xff
      ),
    ].join('');
    const decoded = decodeOriginTrialToken(btoa(header + payload));
    expect(decoded).not.toBeNull();
    expect(decoded?.feature).toBe('WebMCP');
    expect(decoded?.origin).toContain('vkvstudio.com');
    expect(decoded?.expiry).toBe(1_795_000_000);
    expect(decoded?.isSubdomain).toBe(true);
  });

  it('stays coherently dormant while no token is configured', () => {
    if (ORIGIN_TRIAL_TOKEN) return; // configured — the checks below take over
    // Dormant means dormant: no half-configured state where a token exists
    // but cannot be read, which would ship a meta tag that does nothing.
    expect(ORIGIN_TRIAL_TOKEN).toBe('');
    expect(decodeOriginTrialToken(ORIGIN_TRIAL_TOKEN)).toBeNull();
  });

  it('carries a readable payload once a token IS configured', () => {
    if (!ORIGIN_TRIAL_TOKEN) return;
    const decoded = decodeOriginTrialToken(ORIGIN_TRIAL_TOKEN);
    expect(decoded, 'token is set but does not decode — wrong string pasted?').not.toBeNull();
    expect(decoded?.origin, 'token is for another origin').toContain('vkvstudio.com');
    expect(decoded?.feature, 'token is for another feature').toMatch(/webmcp/i);
  });

  it('fails the build before the token expires, not after', () => {
    if (!ORIGIN_TRIAL_TOKEN) return;
    const decoded = decodeOriginTrialToken(ORIGIN_TRIAL_TOKEN);
    const daysLeft = ((decoded?.expiry ?? 0) * 1000 - Date.now()) / DAY_MS;
    expect(
      daysLeft,
      `The WebMCP origin-trial token expires in ${Math.floor(daysLeft)} days. Chrome will ` +
        'drop it in silence — no console error, no audit. Renew at ' +
        'https://developer.chrome.com/origintrials, paste the new token into ' +
        'src/lib/webmcp/origin-trial.ts, then rebuild and redeploy.'
    ).toBeGreaterThan(RENEWAL_WARNING_DAYS);
  });
});
