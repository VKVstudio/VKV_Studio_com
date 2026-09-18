/**
 * Base URL of the Synapse inference backend.
 * Override at build time with PUBLIC_SYNAPSE_API_URL (e.g. https://api.vkvstudio.com).
 * Falls back to localhost for local development.
 *
 * NOTE: an EMPTY string counts as "unset". `.env.example` ships
 * `PUBLIC_SYNAPSE_API_URL=` (blank), and `??` only catches undefined — so a blank
 * value would silently make the base `""`, sending every `/api/*` call to the
 * FRONTEND origin (404 → the whole assistant falls back to the mock). Trim + `||`
 * so blank/whitespace correctly falls through to the localhost default.
 */
const _configuredApiUrl = (import.meta.env.PUBLIC_SYNAPSE_API_URL as string | undefined)?.trim();
export const SYNAPSE_API_BASE: string = (_configuredApiUrl || 'http://localhost:8000').replace(
  /\/$/,
  ''
);
