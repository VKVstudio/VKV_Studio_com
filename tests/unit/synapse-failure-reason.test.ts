import { describe, expect, it } from 'vitest';
import { describeFailure, httpError, SynapseHttpError } from '../../src/lib/synapse-client';

/**
 * The defect: every backend failure was flattened into
 * `new Error("HTTP 503: Service Unavailable")`, so the terminal could only ever
 * say "backend unavailable". But the inference server distinguishes these
 * deliberately — `main.py` sheds load with 503 + `Retry-After: 5`, and
 * rate-limits with 429 — and in both of those cases the backend is up, reachable
 * and answering. Telling the visitor it is unavailable is simply untrue, and on
 * a site whose whole pitch is honest numbers that matters more than usual.
 */

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('httpError', () => {
  it('carries the status', () => {
    expect(httpError(res(500)).status).toBe(500);
  });

  it('reads a numeric Retry-After', () => {
    expect(httpError(res(503, { 'Retry-After': '5' })).retryAfter).toBe(5);
  });

  it('leaves retryAfter undefined when the header is absent', () => {
    expect(httpError(res(429)).retryAfter).toBeUndefined();
  });

  it('ignores an HTTP-date Retry-After rather than reporting NaN seconds', () => {
    // RFC 9110 permits a date here. We do not parse it; reporting nothing is
    // better than reporting NaN, which would render as "(NaNs)" in the tooltip.
    const e = httpError(res(503, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
    expect(e.retryAfter).toBeUndefined();
  });

  it('ignores a negative Retry-After', () => {
    expect(httpError(res(503, { 'Retry-After': '-1' })).retryAfter).toBeUndefined();
  });

  it('is an Error, so existing catch blocks keep working', () => {
    const e = httpError(res(500));
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('500');
  });
});

describe('describeFailure', () => {
  it('calls 503 busy and keeps the retry hint', () => {
    const info = describeFailure(new SynapseHttpError(503, 'Service Unavailable', 5));
    expect(info).toEqual({ kind: 'busy', status: 503, retryAfter: 5 });
  });

  it('calls 429 busy', () => {
    expect(describeFailure(new SynapseHttpError(429, 'Too Many Requests')).kind).toBe('busy');
  });

  it('calls any other status an error, NOT unreachable', () => {
    // The distinction that was missing: the server answered. It answered badly,
    // but it answered.
    expect(describeFailure(new SynapseHttpError(500, 'Internal Server Error'))).toEqual({
      kind: 'error',
      status: 500,
    });
  });

  it('calls a network-level failure unreachable', () => {
    expect(describeFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
  });

  it('does not invent detail for a non-Error throw', () => {
    expect(describeFailure('something odd')).toEqual({ kind: 'unreachable' });
  });
});

describe('policy refusals are not "the backend is broken"', () => {
  it('calls 401 an auth problem, not an error', () => {
    // Live generation is signed-in only because it runs on a metered GPU.
    // Reporting that as a generic failure would leave the visitor with a
    // scripted reply and no idea that signing in is what unlocks the model.
    expect(describeFailure(new SynapseHttpError(401, 'Unauthorized')).kind).toBe('auth');
  });

  it('calls 403 an auth problem too', () => {
    expect(describeFailure(new SynapseHttpError(403, 'Forbidden')).kind).toBe('auth');
  });

  it('separates a spent quota from a busy server, by how long the wait is', () => {
    // The backend uses 429 for both. Load-shedding says "retry in ~5s"; a spent
    // allowance says "retry in hours". Calling the second one "busy" would be a
    // lie the visitor could time.
    const shed = describeFailure(new SynapseHttpError(503, 'Service Unavailable', 5));
    const spent = describeFailure(new SynapseHttpError(429, 'Too Many Requests', 4 * 3600));
    expect(shed.kind).toBe('busy');
    expect(spent.kind).toBe('quota');
    expect(spent.retryAfter).toBe(4 * 3600);
  });

  it('treats a 429 with no Retry-After as busy rather than inventing a quota', () => {
    expect(describeFailure(new SynapseHttpError(429, 'Too Many Requests')).kind).toBe('busy');
  });
});
