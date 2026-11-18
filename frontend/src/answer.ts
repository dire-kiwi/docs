// Reading a form field's answer from the renderer's HTML: shared by the site's autosave (fields.ts) and the Huntaway
// plugin's page script.

export type Answer =
  | string
  | number
  | boolean
  | string[]
  | { decision: string; comment: string }
  | null;

/** Read the current answer from a server-rendered `.field` element. */
export function fieldValue(field: HTMLElement): Answer {
  const kind = field.dataset.kind;
  const checked = (): HTMLInputElement[] => [
    ...field.querySelectorAll<HTMLInputElement>("input:checked"),
  ];
  switch (kind) {
    case "text":
      return field.querySelector("input")?.value ?? "";
    case "textarea":
      return field.querySelector("textarea")?.value ?? "";
    case "select":
      return field.querySelector("select")?.value ?? "";
    case "radio":
      return checked()[0]?.value ?? null;
    case "scale": {
      const v = checked()[0]?.value;
      return v === undefined ? null : Number(v);
    }
    case "checkboxes":
      return checked().map((i) => i.value);
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
