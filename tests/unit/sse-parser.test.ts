/**
 * parseSSEStream — the path every streamed token takes.
 *
 * It had no tests because it was unreachable: the function lived inside the
 * client factory's closure. It was also wrong. An SSE event is two lines,
 * `event: token` then `data: …`, and a network chunk boundary falls wherever
 * TCP decides — including between them. The event name was reset on every
 * read(), so a split pair produced no token, no error, and a reply silently
 * missing a word. That is the worst class of bug this site can ship: it looks
 * like the model wrote a bad sentence.
 *
 * Every test below therefore feeds the parser the SAME stream, split in a
 * different hostile place. A parser that only passes the happy split is the
 * parser we had.
 */
import { describe, it, expect } from 'vitest';
import { parseSSEStream } from '@/lib/synapse-client';

/** A Response whose body yields exactly the given chunks, in order. */
function responseOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader() {
      return {
        read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (i >= chunks.length) return Promise.resolve({ done: true });
          const value = encoder.encode(chunks[i]!);
          i += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
  return { body } as unknown as Response;
}

async function collect(chunks: string[]): Promise<Array<[string, string]>> {
  const events: Array<[string, string]> = [];
  let doneCalled = false;
  await parseSSEStream(responseOf(chunks), {
    onEvent: (event, data) => events.push([event, data]),
    onDone: () => {
      doneCalled = true;
    },
  });
  expect(doneCalled).toBe(true);
  return events;
}

/** Three tokens then a done event — the shape /api/chat/stream actually sends. */
const STREAM =
  'event: token\ndata: Hello\n\n' +
  'event: token\ndata:  world\n\n' +
  'event: token\ndata: !\n\n' +
  'event: done\ndata: [DONE]\n\n';

const EXPECTED: Array<[string, string]> = [
  ['token', 'Hello'],
  ['token', ' world'],
  ['token', '!'],
  ['done', '[DONE]'],
];

/** Every way to cut a string in two, so no split can hide. */
function everySplit(s: string): string[][] {
  const out: string[][] = [];
  for (let i = 1; i < s.length; i += 1) out.push([s.slice(0, i), s.slice(i)]);
  return out;
}

describe('parseSSEStream', () => {
  it('parses a stream delivered in one chunk', async () => {
    expect(await collect([STREAM])).toEqual(EXPECTED);
  });

  it('parses a stream delivered one character at a time', async () => {
    expect(await collect([...STREAM])).toEqual(EXPECTED);
  });

  it('survives a split at every single byte offset', async () => {
    // The regression lived at exactly one of these offsets — between an
    // `event:` line and its `data:` line. Asserting all of them means the next
    // person cannot reintroduce it by moving a declaration.
    for (const chunks of everySplit(STREAM)) {
      expect(await collect(chunks)).toEqual(EXPECTED);
    }
  });

  it('keeps the event name across the read that splits a pair', async () => {
    // The precise failing case, stated on its own so a failure names itself.
    expect(await collect(['event: token\n', 'data: Hello\n\n'])).toEqual([['token', 'Hello']]);
  });

  it('emits a final event that arrives without a trailing newline', async () => {
    // A clean close right after the last data line: the line is complete, but
    // the loop had parked it in `buffer` and never looked at it again.
    expect(await collect(['event: token\ndata: tail'])).toEqual([['token', 'tail']]);
  });

  it('does not split a multi-byte character across chunks', async () => {
    // Russian is half this site's traffic; every Cyrillic letter is two bytes,
    // and a chunk boundary can fall between them. TextDecoder({stream:true})
    // handles it only if the same decoder sees both halves.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('event: token\ndata: Привет\n\n');
    const cut = 20; // lands mid-letter
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    let i = 0;
    const res = {
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              i >= chunks.length ? { done: true } : { done: false, value: chunks[i++]! }
            ),
        }),
      },
    } as unknown as Response;

    const events: Array<[string, string]> = [];
    await parseSSEStream(res, { onEvent: (e, d) => events.push([e, d]) });
    expect(events).toEqual([['token', 'Привет']]);
  });

  it('drops a data line that no event line introduced', async () => {
    // Deliberate: an unnamed data line has no meaning to the caller's switch.
    expect(await collect(['data: orphan\n\n'])).toEqual([]);
  });

  it('throws when the response has no body', async () => {
    await expect(
      parseSSEStream({ body: null } as unknown as Response, { onEvent: () => {} })
    ).rejects.toThrow('No response body');
  });
});
