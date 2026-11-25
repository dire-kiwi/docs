/**
 * The inspector: what the selected element is, and fields for its text, attributes and
 * the CSS properties people adjust most. A field shows the value the element has (its
 * used value) and sets the property in the element's `style` attribute when changed; a
 * property set there is marked, and can be taken out again.
 */
import { cssLength, shownLength } from "./markup.ts";
import type { Detail, Path } from "./types.ts";
import { colorOf, h, withAlpha } from "./ui.ts";

export interface InspectorApi {
  setStyle(property: string, value: string | null): void;
  setText(text: string): void;
  setAttr(name: string, value: string | null): void;
  select(path: Path): void;
  hover(path: Path | null): void;
  remove(): void;
  duplicate(): void;
  move(by: number): void;
  editText(): void;
  /** Absent where the reader can't comment. */
  comment?: (() => void) | undefined;
}

interface FieldDef {
  /** The property whose used value is shown. */
  read: string;
  /** The property that is set, when it is a shorthand of the one read. */
  set?: string;
  label: string;
  kind: "length" | "text" | "color" | "select" | "number";
  options?: string[];
  /** Shown only for elements this holds for. */
  when?: (d: Detail) => boolean;
  wide?: boolean;
}

const isFlex = (d: Detail) => /flex|grid/.test(d.computed.display ?? "");
const ALIGN = [
  "normal",
  "stretch",
  "flex-start",
  "center",
  "flex-end",
  "space-between",
  "space-around",
  "space-evenly",
  "baseline",
];

const SECTIONS: { title: string; cols?: number; fields: FieldDef[] }[] = [
  {
    title: "Layout",
    fields: [
      {
        read: "display",
        label: "Display",
        kind: "select",
        options: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "none"],
      },
      {
        read: "flex-direction",
        label: "Direction",
        kind: "select",
        options: ["row", "column", "row-reverse", "column-reverse"],
        when: (d) => /flex/.test(d.computed.display ?? ""),
      },
      { read: "justify-content", label: "Justify", kind: "select", options: ALIGN, when: isFlex },
      { read: "align-items", label: "Align", kind: "select", options: ALIGN, when: isFlex },
      { read: "gap", label: "Gap", kind: "length", when: isFlex },
      { read: "width", label: "Width", kind: "length" },
      { read: "height", label: "Height", kind: "length" },
    ],
  },
  {
    title: "Padding",
    cols: 4,
    fields: [
      { read: "padding-top", label: "Top", kind: "length" },
      { read: "padding-right", label: "Right", kind: "length" },
      { read: "padding-bottom", label: "Bottom", kind: "length" },
      { read: "padding-left", label: "Left", kind: "length" },
    ],
  },
  {
    title: "Margin",
    cols: 4,
    fields: [
      { read: "margin-top", label: "Top", kind: "length" },
      { read: "margin-right", label: "Right", kind: "length" },
      { read: "margin-bottom", label: "Bottom", kind: "length" },
      { read: "margin-left", label: "Left", kind: "length" },
    ],
  },
  {
    title: "Text",
    fields: [
      { read: "font-family", label: "Font", kind: "text", wide: true },
      { read: "font-size", label: "Size", kind: "length" },
      {
        read: "font-weight",
        label: "Weight",
        kind: "select",
        options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
      },
      { read: "line-height", label: "Line height", kind: "text" },
      { read: "letter-spacing", label: "Spacing", kind: "length" },
      {
        read: "text-align",
        label: "Align",
        kind: "select",
        options: ["start", "left", "center", "right", "justify", "end"],
      },
      { read: "color", label: "Colour", kind: "color", wide: true },
    ],
  },
  {
    title: "Fill",
    fields: [
      { read: "background-color", label: "Background", kind: "color", wide: true },
      { read: "opacity", label: "Opacity", kind: "number" },
    ],
  },
  {
    title: "Border",
    fields: [
      { read: "border-top-width", set: "border-width", label: "Width", kind: "length" },
      {
        read: "border-top-style",
        set: "border-style",
        label: "Style",
        kind: "select",
        options: ["none", "solid", "dashed", "dotted", "double"],
      },
      { read: "border-top-left-radius", set: "border-radius", label: "Radius", kind: "length" },
      { read: "border-top-color", set: "border-color", label: "Colour", kind: "color", wide: true },
      { read: "box-shadow", label: "Shadow", kind: "text", wide: true },
    ],
  },
];

const ATTR_LABELS: Record<string, string> = {
  href: "Link",
  src: "Source",
  alt: "Alt text",
  placeholder: "Placeholder",
  value: "Value",
  title: "Title",
};

type Update = (d: Detail) => void;

/** A value moved by an arrow key: the number in it, a step up or down. */
function nudge(value: string, by: number): string | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(value.trim());
  if (!m) return null;
  const n = Math.round((Number(m[1]) + by) * 100) / 100;
  return `${n}${m[2] ?? ""}`;
}

export function createInspector(api: InspectorApi): {
  el: HTMLElement;
  show(detail: Detail | null, key: string): void;
} {
  const el = h("div", { className: "dz-inspector" });
  let shown = "";
  let updates: Update[] = [];
  const focused = (node: Element) => node === document.activeElement;

  function field(def: FieldDef): { el: HTMLElement; update: Update } {
    const set = def.set ?? def.read;
    const reset = h(
      "button",
      {
        type: "button",
        className: "dz-reset",
        title: "Take this out of the element's style",
        onclick: () => api.setStyle(set, null),
      },
      "×",
    );
    const label = h("span", { className: "dz-fl" }, def.label, reset);
    const wrap = h("label", { className: `dz-f${def.wide ? " dz-wide" : ""}` }, label);
    const valueOf = (d: Detail) =>
      d.inline[def.read] ?? d.inline[set] ?? d.computed[def.read] ?? "";
    let apply: Update;

    if (def.kind === "select") {
      const select = h("select", { onchange: () => api.setStyle(set, select.value) });
      wrap.append(select);
      apply = (d) => {
        const value = valueOf(d);
        const options =
          def.options?.includes(value) || value === ""
            ? (def.options ?? [])
            : [value, ...(def.options ?? [])];
        select.replaceChildren(...options.map((o) => h("option", { value: o }, o)));
        select.value = value;
      };
    } else if (def.kind === "color") {
      let alpha = 1;
      const swatch = h("input", {
        type: "color",
        oninput: () => api.setStyle(set, withAlpha(swatch.value, alpha === 0 ? 1 : alpha)),
      });
      const text = h("input", {
        type: "text",
        spellcheck: "false",
        onchange: () => api.setStyle(set, text.value.trim() === "" ? null : text.value),
      });
      wrap.append(h("span", { className: "dz-color" }, swatch, text));
      apply = (d) => {
        const value = valueOf(d);
        const color = colorOf(d.computed[def.read] ?? "");
        alpha = color?.alpha ?? 1;
        if (!focused(swatch)) swatch.value = color?.hex ?? "#000000";
        swatch.classList.toggle("dz-clear", alpha === 0);
        if (!focused(text)) text.value = value;
      };
    } else {
      const input = h("input", {
        type: def.kind === "number" ? "number" : "text",
        spellcheck: "false",
        ...(def.kind === "number" ? { min: "0", max: "1", step: "0.05" } : {}),
      });
      const commit = () => {
        const raw = input.value.trim();
        api.setStyle(set, raw === "" ? null : def.kind === "length" ? cssLength(raw) : raw);
      };
      input.addEventListener("input", commit);
      if (def.kind === "length") {
        input.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          const next = nudge(input.value, (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
          if (next === null) return;
          e.preventDefault();
          input.value = next;
          commit();
        });
      }
      wrap.append(input);
      apply = (d) => {
        if (focused(input)) return;
        const value = valueOf(d);
        input.value = def.kind === "length" ? shownLength(value) : value;
      };
    }
    return {
      el: wrap,
      update(d) {
        wrap.hidden = def.when ? !def.when(d) : false;
        wrap.classList.toggle(
          "dz-set",
          d.inline[def.read] !== undefined || d.inline[set] !== undefined,
        );
        apply(d);
      },
    };
  }

  function build(d: Detail) {
    updates = [];
    const size = h("span", { className: "dz-muted" });
    const name = h("strong", {});
    const crumbs = h("div", { className: "dz-crumbs" });
    updates.push((now) => {
      name.textContent = now.label;
      size.textContent = `${Math.round(now.rect.w)} × ${Math.round(now.rect.h)}`;
      crumbs.replaceChildren(
        ...now.crumbs.flatMap((c) => [
          h(
            "button",
            {
              type: "button",
              className: "dz-crumb",
              onclick: () => api.select(c.path),
              onmouseenter: () => api.hover(c.path),
              onmouseleave: () => api.hover(null),
            },
            c.label,
          ),
          h("span", { className: "dz-muted" }, "›"),
        ]),
      );
    });
    const action = (label: string, title: string, run: () => void, cls = "") =>
      h("button", { type: "button", title, className: cls, onclick: run }, label);
    const parent = d.crumbs.at(-1);
    const head = h(
      "div",
      { className: "dz-el" },
      crumbs,
      h("div", { className: "dz-el-name" }, name, size),
      h(
        "div",
        { className: "dz-el-actions" },
        parent ? action("Parent", "Select its parent (Esc)", () => api.select(parent.path)) : null,
        d.hasText
          ? action("Edit text", "Edit its text in place (Enter, or double-click it)", () =>
              api.editText(),
            )
          : null,
        api.comment
          ? action("Comment", "Comment on this element for the agent", api.comment.bind(api))
          : null,
        d.tag === "body"
          ? null
          : action("Duplicate", "Copy it after itself (Ctrl+D)", () => api.duplicate()),
        d.tag === "body"
          ? null
          : action("←", "Move it before the element in front of it", () => api.move(-1)),
        d.tag === "body"
          ? null
          : action("→", "Move it after the element behind it", () => api.move(1)),
        d.tag === "body"
          ? null
          : action("Delete", "Remove it (Delete)", () => api.remove(), "dz-danger"),
      ),
    );

    const content = h("div", { className: "dz-fields" });
    if (d.text !== null) {
      const text = h("textarea", { rows: "3", oninput: () => api.setText(text.value) });
      content.append(
        h("label", { className: "dz-f dz-wide" }, h("span", { className: "dz-fl" }, "Text"), text),
      );
      updates.push((now) => {
        if (!focused(text) && now.text !== null) text.value = now.text;
      });
    }
    for (const attr of Object.keys(d.attrs)) {
      const input = h("input", {
        type: "text",
        spellcheck: "false",
        onchange: () => api.setAttr(attr, input.value),
      });
      content.append(
        h(
          "label",
          { className: "dz-f dz-wide" },
          h("span", { className: "dz-fl" }, ATTR_LABELS[attr] ?? attr),
          input,
        ),
      );
      updates.push((now) => {
        if (!focused(input)) input.value = now.attrs[attr] ?? "";
      });
    }

    const sections = SECTIONS.map((s) => {
      const fields = s.fields.map(field);
      updates.push(...fields.map((f) => f.update));
      return h(
        "section",
        {},
        h("h3", {}, s.title),
        h(
          "div",
          { className: `dz-fields${s.cols === 4 ? " dz-four" : ""}` },
          ...fields.map((f) => f.el),
        ),
      );
    });

    // Everything its style attribute sets, and a way to set anything else.
    const raw = h("div", { className: "dz-raw" });
    const property = h("input", {
      type: "text",
      placeholder: "property",
      spellcheck: "false",
      "aria-label": "CSS property",
    });
    const value = h("input", {
      type: "text",
      placeholder: "value",
      spellcheck: "false",
      "aria-label": "Its value",
    });
    const add = () => {
      if (property.value.trim() === "" || value.value.trim() === "") return;
      api.setStyle(property.value.trim().toLowerCase(), value.value);
      property.value = "";
      value.value = "";
      property.focus();
    };
    for (const input of [property, value]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") add();
      });
    }
    updates.push((now) => {
      raw.replaceChildren(
        ...Object.entries(now.inline).map(([p, v]) =>
          h(
            "div",
            { className: "dz-decl" },
            h("code", {}, `${p}: ${v.length > 60 ? `${v.slice(0, 60)}…` : v}`),
            h(
              "button",
              {
                type: "button",
                className: "dz-reset",
                title: "Remove",
                onclick: () => api.setStyle(p, null),
              },
              "×",
            ),
          ),
        ),
      );
    });
    const custom = h(
      "section",
      {},
      h("h3", {}, "Style attribute"),
      raw,
      h(
        "div",
        { className: "dz-add" },
        property,
        value,
        h("button", { type: "button", onclick: add }, "Set"),
      ),
    );

    el.replaceChildren(head, content.childElementCount > 0 ? content : "", ...sections, custom);
  }

  return {
    el,
    show(detail, key) {
      if (!detail) {
        shown = "";
        updates = [];
        el.replaceChildren(
          h(
            "div",
            { className: "dz-hint" },
            h("p", {}, "Click an element of a mockup to inspect and change it."),
            h("p", {}, "Double-click text to edit it in place. Esc selects the element around it."),
            h(
              "p",
              {},
              "Scroll to move around, Ctrl + scroll (or pinch) to zoom, and hold Space to drag the canvas.",
            ),
          ),
        );
        return;
      }
      // The same element again keeps its fields (and the one being typed in).
      const identity = `${key}:${detail.tag}:${Object.keys(detail.attrs).join(",")}:${detail.text === null}`;
      if (identity !== shown) {
        shown = identity;
        build(detail);
      }
      for (const update of updates) update(detail);
    },
  };
}
