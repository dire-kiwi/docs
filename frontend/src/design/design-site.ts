import { api } from "../api.ts";
import { mountDesign } from "./design.ts";
import type { DesignComment, DesignData, DesignDraft, DesignSaved } from "./design.ts";
import { directFrame } from "./frames.ts";

/**
 * The design editor on the hosted site (a mockup's page, `/d/<uuid>/<page>`): it shows
 * the mockups in frames of the site's own origin that run no scripts, saves the changed
 * ones with `POST /api/documents/<uuid>/versions` (which answers 409 when a version was
 * published since the page opened), and keeps comments with the reader's other comments.
 */
export function initDesign(): void {
  const root = document.querySelector<HTMLElement>("#design");
  const json = document.querySelector("#design-data")?.textContent;
  if (!root || !json) return;
  const data = JSON.parse(json) as DesignData;
  const saveUrl = root.dataset.saveUrl;
  const versionId = root.dataset.versionId === undefined ? null : Number(root.dataset.versionId);
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
  const draftKey = `docs-design:${root.dataset.uuid ?? ""}`;

  const editor = mountDesign(root, data, {
    frame: directFrame,
    save:
      saveUrl === undefined
        ? undefined
        : async (request): Promise<DesignSaved> => {
            const res = await fetch(saveUrl, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
              body: JSON.stringify({ ...request, title: data.title, merge: true }),
            });
            let body: Record<string, unknown> = {};
            try {
              body = (await res.json()) as Record<string, unknown>;
            } catch {
              // not JSON
            }
            const error =
              typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
            if (res.status === 409 && typeof body.latest_version === "number") {
              return { conflict: body.latest_version, message: error };
            }
            if (!res.ok) throw new Error(error);
            return body as { url: string; version: number };
          },
    addComment:
      versionId === null
        ? undefined
        : async (c): Promise<DesignComment> => {
            const made = await api<{ id: number; user: string; created_at: number }>(
              "POST",
              "/api/selections",
              {
                version_id: versionId,
                ...c,
              },
            );
            return { ...c, ...made, mine: true };
          },
    deleteComment: versionId === null ? undefined : (id) => api("DELETE", `/api/selections/${id}`),
    go(url) {
      window.location.assign(url);
    },
    drafts: {
      async load() {
        try {
          const raw = localStorage.getItem(draftKey);
          return raw === null ? null : (JSON.parse(raw) as DesignDraft);
        } catch {
          return null;
        }
      },
      async save(draft) {
        localStorage.setItem(draftKey, JSON.stringify(draft));
      },
      async clear() {
        localStorage.removeItem(draftKey);
      },
    },
  });
  window.addEventListener("beforeunload", (e) => {
    if (editor.dirty()) e.preventDefault();
  });
}
