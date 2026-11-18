import { fieldValue, linkOther } from "./answer.ts";
import { api } from "./api.ts";

/** Answers save as the reader types: text after a pause, choices immediately. */
export function initFields(): void {
  for (const field of document.querySelectorAll<HTMLElement>(".field[data-field]")) {
    linkOther(field);
    const article = field.closest<HTMLElement>("[data-version-id]");
    const status = field.querySelector<HTMLElement>(".field-status");
    const setStatus = (text: string, state = ""): void => {
      if (!status) return;
      status.textContent = text;
      status.dataset.state = state;
    };
    if (!article) {
      // e.g. the examples on the components page
      field.addEventListener("change", () => setStatus("Preview: answers are not saved here"));
      continue;
    }
    const versionId = Number(article.dataset.versionId);
    const page = article.dataset.page ?? "";
    let timer: number | undefined;
    let inflight = Promise.resolve();

    const save = (): void => {
      window.clearTimeout(timer);
      const value = fieldValue(field);
      setStatus("Saving…", "saving");
      // Serialise saves so an older answer never overwrites a newer one.
      inflight = inflight.then(async () => {
        try {
          await api("POST", "/api/responses", {
            version_id: versionId,
            page,
            field: field.dataset.field,
            value,
          });
          setStatus("Saved", "saved");
        } catch (e) {
          setStatus(`Not saved: ${(e as Error).message}`, "error");
        }
      });
    };

    field.addEventListener("input", (e) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && target.type === "text")
      ) {
        setStatus("Editing…");
        window.clearTimeout(timer);
        timer = window.setTimeout(save, 700);
      }
    });
    field.addEventListener("change", save);
  }
}
