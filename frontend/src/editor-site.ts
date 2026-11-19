import { api } from "./api.ts";
import { mountEditor } from "./editor.ts";
import type {
  Draft,
  DraftStore,
  EditorData,
  PreviewResult,
  SaveRequest,
  SaveResult,
} from "./editor.ts";

/** Drafts in the browser's storage, one per document (and one for a new document). */
export function localDrafts(key: string): DraftStore {
  return {
    async load() {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as Draft);
      } catch {
        return null;
      }
    },
    async save(draft) {
      try {
        localStorage.setItem(key, JSON.stringify(draft));
      } catch {
        // Too big with its images (or storage is off): keep the text at least.
        localStorage.setItem(key, JSON.stringify({ ...draft, uploads: [] }));
      }
    },
    async clear() {
      localStorage.removeItem(key);
    },
  };
}

/**
 * The editor on the hosted site (`/d/<slug>/-/edit/…` and `/new`): it previews with
 * `POST /api/preview` and saves with `POST /api/documents` (a new document) or
 * `POST /api/documents/<slug>/versions`, which answers 409 when a version was
 * published since the editor opened.
 */
export function initEditor(): void {
  const root = document.querySelector<HTMLElement>("#editor[data-save-url]");
  const json = document.querySelector("#editor-data")?.textContent;
  if (!root || !json) return;
  const data = JSON.parse(json) as EditorData;
  const slug = root.dataset.slug ?? null;
  const saveUrl = root.dataset.saveUrl ?? "";
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";

  const editor = mountEditor(root, data, {
    async preview(page) {
      const out = await api<{
        html: string | null;
        has_h1: boolean;
        warnings: string[];
        error: string | null;
      }>("POST", "/api/preview", { slug, version: data.baseVersion, ...page });
      const result: PreviewResult = {
        html: out.html,
        hasH1: out.has_h1,
        warnings: out.warnings,
        error: out.error,
      };
      return result;
    },
    async save(request: SaveRequest): Promise<SaveResult> {
      const res = await fetch(saveUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(request),
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      const error = typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
      if (res.status === 409 && typeof body.latest_version === "number") {
        return { conflict: body.latest_version, message: error };
      }
      if (!res.ok) throw new Error(error);
      return body as SaveResult;
    },
    go(url) {
      window.location.assign(url);
    },
    drafts: localDrafts(slug === null ? "docs-draft-new" : `docs-draft:${slug}`),
  });
  window.addEventListener("beforeunload", (e) => {
    if (editor.dirty()) e.preventDefault();
  });
}
