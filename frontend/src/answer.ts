// Reading a form field's answer from the renderer's HTML: shared by the site's autosave (fields.ts) and the Huntaway
// plugin's page script.

export type Answer =
  | string
  | number
  | boolean
  | string[]
  | { decision: string; comment: string }
  | null;

/** The text typed in a field's "Other" box (`other` on Select, RadioGroup and CheckboxGroup). */
const otherText = (field: HTMLElement): string =>
  field.querySelector<HTMLInputElement>("input.other-text")?.value.trim() ?? "";

/** Read the current answer from a server-rendered `.field` element. */
export function fieldValue(field: HTMLElement): Answer {
  const kind = field.dataset.kind;
  const checked = (): HTMLInputElement[] => [
    ...field.querySelectorAll<HTMLInputElement>("input:checked"),
  ];
  // A chosen "Other" answers with the text typed for it.
  const valueOf = (i: HTMLInputElement | HTMLOptionElement): string =>
    i.hasAttribute("data-other") ? otherText(field) : i.value;
  switch (kind) {
    case "text":
      return field.querySelector("input")?.value ?? "";
    case "textarea":
      return field.querySelector("textarea")?.value ?? "";
    case "select": {
      const option = field.querySelector("select")?.selectedOptions[0];
      return option ? valueOf(option) : "";
    }
    case "radio": {
      const c = checked()[0];
      return c ? valueOf(c) : null;
    }
    case "scale": {
      const v = checked()[0]?.value;
      return v === undefined ? null : Number(v);
    }
    case "checkboxes":
      return checked()
        .map(valueOf)
        .filter((v) => v !== "");
    case "checkbox":
      return field.querySelector<HTMLInputElement>("input")?.checked ?? false;
    case "approval":
      return {
        decision: checked()[0]?.value ?? "",
        comment: field.querySelector("textarea")?.value ?? "",
      };
    default:
      return null;
  }
}

/**
 * Typing in a field's "Other" box chooses Other, and choosing Other moves to its box. Choosing Other raises `change`
 * as clicking it would, so the answer saves.
 */
export function linkOther(field: HTMLElement): void {
  const box = field.querySelector<HTMLInputElement>("input.other-text");
  if (!box) return;
  box.addEventListener("input", () => {
    const choice = field.querySelector<HTMLInputElement>("input[data-other]");
    const option = field.querySelector<HTMLOptionElement>("option[data-other]");
    if (box.value.trim() === "") return;
    if (choice && !choice.checked) {
      choice.checked = true;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (option && !option.selected) {
      option.selected = true;
      option.parentElement?.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  field.addEventListener("change", (e) => {
    const t = e.target;
    const chose =
      (t instanceof HTMLInputElement && t.hasAttribute("data-other") && t.checked) ||
      (t instanceof HTMLSelectElement && t.selectedOptions[0]?.hasAttribute("data-other"));
    if (chose && e.isTrusted) box.focus();
  });
}
