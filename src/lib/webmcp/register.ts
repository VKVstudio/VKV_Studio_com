/**
 * Registers this page's tools with the browser's agent surface, if it has one.
 *
 * Loaded ONLY by a dynamic import that runs after `'modelContext' in document`
 * is already true (see BaseLayout.astro). That ordering is the whole point:
 * no visitor without the API downloads THIS file or the ~49 KB of service data
 * behind it. What they do pay is the 221-byte check itself, which every page
 * carries — small, but not the "zero" an earlier version of this comment
 * claimed.
 *
 * Namespace, verified 2026-09-20: the canon is `document.modelContext`.
 * `navigator.modelContext` was the Chrome-149 spelling, became a deprecated
 * alias in 150, and is GONE from stable 153 — so there is nothing to fall back
 * to and we never touch it. (Touching it would also have cost us a deprecation
 * warning in Lighthouse's Best Practices audit, on a site that sells a 99/100
 * clause.)
 *
 * In a multi-page app the ModelContext lives exactly as long as its Document,
 * so registration happens per page load. There is nothing to unregister and no
 * AbortSignal to thread: the navigation that ends the page ends the context.
 */

import { buildTools, type Lang } from './tools';

/** The slice of the WebMCP surface we use. Structural typing on purpose —
 *  the spec is a Draft Community Group Report and still moving, so we assert
 *  the one method we call rather than pinning a shape that may be revised. */
interface ModelContextLike {
  registerTool?: (tool: unknown) => unknown;
}

function getModelContext(): ModelContextLike | null {
  const mc = (document as Document & { modelContext?: unknown }).modelContext;
  if (!mc || typeof mc !== 'object') return null;
  const candidate = mc as ModelContextLike;
  return typeof candidate.registerTool === 'function' ? candidate : null;
}

export function registerSiteTools(lang: Lang): number {
  const mc = getModelContext();
  if (!mc?.registerTool) return 0;

  let registered = 0;
  for (const tool of buildTools(lang)) {
    try {
      mc.registerTool({
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        annotations: tool.annotations,
        // The spec accepts a bare string or an MCP content object; we send the
        // object because that is what the standard's own examples return.
        execute: (input: Record<string, unknown>) => ({
          content: [{ type: 'text', text: tool.execute(input ?? {}) }],
        }),
      });
      registered += 1;
    } catch {
      // An experimental API mid-revision may reject a shape it accepted last
      // milestone. One tool failing must not take the page's other tools —
      // or anything else on the page — down with it.
    }
  }
  return registered;
}
