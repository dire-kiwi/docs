/**
 * The editor's side of a mockup's frame on the Huntaway board, where the frame is out of
 * the editor's reach (see frames.ts): it does in the frame what the editor asks in
 * messages, and tells it what happens there. It is bundled on its own and put in the
 * frame as source.
 */
import { createCore } from "./core.ts";
import { CORE_METHODS } from "./types.ts";
import type { FrameCore } from "./types.ts";

const post = (message: Record<string, unknown>) => parent.postMessage({ dz: message }, "*");
const core = createCore(window, (event) => post({ event }));

addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = (e.data as { dz?: { id?: unknown; method?: unknown; args?: unknown } } | null)?.dz;
  if (!m || typeof m.id !== "number" || typeof m.method !== "string" || !Array.isArray(m.args))
    return;
  if (!CORE_METHODS.includes(m.method as keyof FrameCore)) return;
  try {
    const call = core[m.method as keyof FrameCore] as (...args: unknown[]) => unknown;
    post({ id: m.id, ok: true, value: call(...(m.args as unknown[])) ?? null });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
post({ ready: true });
