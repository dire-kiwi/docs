/**
 * The two ways the editor holds a mockup's frame.
 *
 * On the site the frame is of the page's own origin and may run no scripts
 * (`sandbox="allow-same-origin"`), so the editor works on its document itself: the
 * mockup can load the document's images with the reader's session, and nothing in it runs.
 *
 * On the Huntaway board the editor's own page is already a sandboxed frame with no origin,
 * so a frame inside it is out of its reach. There the frame runs the editor's agent
 * (agent.ts) and they talk in messages; a policy with a one-time nonce lets that script
 * run and nothing the mockup brings.
 */
import { createCore } from "./core.ts";
import { CORE_METHODS } from "./types.ts";
import type { FrameCore, FrameDriver, FrameEvent } from "./types.ts";

type Listener = (event: FrameEvent) => void;

const loaded = (iframe: HTMLIFrameElement) =>
  new Promise<void>((resolve) => iframe.addEventListener("load", () => resolve(), { once: true }));

/** A frame the editor reaches itself. The frame must be in the page already. */
export async function directFrame(iframe: HTMLIFrameElement): Promise<FrameDriver> {
  iframe.setAttribute("sandbox", "allow-same-origin");
  const ready = loaded(iframe);
  iframe.srcdoc = "<!doctype html><html><head></head><body></body></html>";
  await ready;
  const win = iframe.contentWindow;
  if (!win) throw new Error("the mockup's frame didn't load");
  const listeners: Listener[] = [];
  const core = createCore(win, (event) => {
    for (const l of listeners) l(event);
  });
  const driver = { onEvent: (l: Listener) => void listeners.push(l) } as Record<string, unknown>;
  for (const method of CORE_METHODS) {
    const call = core[method] as (...args: unknown[]) => unknown;
    driver[method] = async (...args: unknown[]) => call(...args);
  }
  return driver as unknown as FrameDriver;
}

interface Reply {
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  ready?: boolean;
  event?: FrameEvent;
}

/** A frame that runs `agent` (agent.ts, bundled as source) and is reached in messages. */
export async function remoteFrame(iframe: HTMLIFrameElement, agent: string): Promise<FrameDriver> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const listeners: Listener[] = [];
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let next = 0;
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    const m = (e.data as { dz?: Reply } | null)?.dz;
    if (!m) return;
    if (m.ready) started();
    if (m.event) for (const l of listeners) l(m.event);
    if (typeof m.id === "number") {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve(m.value);
      else w?.reject(new Error(m.error ?? "the mockup's frame failed"));
    }
  });
  // Only the script with this page's nonce runs in the frame: nothing a mockup brings can have it.
  iframe.srcdoc =
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">` +
    `<script nonce="${nonce}">${agent.replace(/<\/script/gi, "<\\/script")}</script>`;
  await ready;
  const driver = { onEvent: (l: Listener) => void listeners.push(l) } as Record<string, unknown>;
  for (const method of CORE_METHODS) {
    driver[method] = (...args: unknown[]) => {
      next += 1;
      const id = next;
      return new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        iframe.contentWindow?.postMessage({ dz: { id, method, args } }, "*");
      });
    };
  }
  return driver as unknown as FrameDriver;
}

export type { FrameCore };
