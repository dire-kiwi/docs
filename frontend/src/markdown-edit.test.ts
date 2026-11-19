import { describe, expect, test } from "vite-plus/test";
import {
  continueList,
  imageCandidates,
  imageName,
  indentLines,
  insertBlock,
  link,
  pagePath,
  prefixLines,
  wrap,
} from "./markdown-edit.ts";
import type { TextState } from "./markdown-edit.ts";

/** A text with `[` and `]` marking the selection (or `|` the caret). */
function at(marked: string): TextState {
  if (marked.includes("|")) {
    const i = marked.indexOf("|");
    return { value: marked.replace("|", ""), start: i, end: i };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}
function show(s: TextState): string {
  if (s.start === s.end) return s.value.slice(0, s.start) + "|" + s.value.slice(s.start);
  return (
    s.value.slice(0, s.start) + "[" + s.value.slice(s.start, s.end) + "]" + s.value.slice(s.end)
  );
}

describe("wrap", () => {
  test("wraps the selection and keeps it selected", () => {
    expect(show(wrap(at("a [word] b"), "**", "**", "bold"))).toBe("a **[word]** b");
  });
  test("inserts a placeholder with nothing selected", () => {
    expect(show(wrap(at("a | b"), "_", "_", "italic"))).toBe("a _[italic]_ b");
  });
  test("unwraps what is wrapped already", () => {
    expect(show(wrap(at("a **[word]** b"), "**", "**", "bold"))).toBe("a [word] b");
    expect(show(wrap(at("a [**word**] b"), "**", "**", "bold"))).toBe("a [word] b");
  });
});

test("link selects the URL to type over", () => {
  const out = link(at("see [the docs] now"));
  expect(out.value).toBe("see [the docs](https://) now");
  expect(out.value.slice(out.start, out.end)).toBe("https://");
});

describe("prefixLines", () => {
  test("makes a heading, replacing another level", () => {
    expect(prefixLines(at("Title|"), "## ").value).toBe("## Title");
    expect(prefixLines(at("### Title|"), "## ").value).toBe("## Title");
  });
  test("takes the prefix off when every line has it", () => {
    expect(prefixLines(at("[- a\n- b]"), "- ").value).toBe("a\nb");
  });
  test("numbers a list", () => {
    expect(prefixLines(at("[a\nb\nc]"), "1. ").value).toBe("1. a\n2. b\n3. c");
  });
  test("switches the kind of list", () => {
    expect(prefixLines(at("[- a\n- b]"), "1. ").value).toBe("1. a\n2. b");
    expect(prefixLines(at("[- a\n- b]"), "- [ ] ").value).toBe("- [ ] a\n- [ ] b");
  });
  test("keeps blank lines in a selection", () => {
    expect(prefixLines(at("[a\n\nb]"), "> ").value).toBe("> a\n\n> b");
  });
  test("only touches the selected lines", () => {
    expect(prefixLines(at("x\n[a]\ny"), "- ").value).toBe("x\n- a\ny");
  });
});

describe("insertBlock", () => {
  test("puts a block on lines of its own", () => {
    expect(insertBlock(at("text|"), "---").value).toBe("text\n\n---\n");
    expect(insertBlock(at("a\n\n|\n\nb"), "---").value).toBe("a\n\n---\n\nb");
    expect(insertBlock(at("|"), "---").value).toBe("---\n");
  });
  test("selects part of it", () => {
    const out = insertBlock(at("|"), "| Column |", "Column");
    expect(out.value.slice(out.start, out.end)).toBe("Column");
  });
});

describe("continueList", () => {
  test("starts the next item", () => {
    expect(show(continueList(at("- one|"))!)).toBe("- one\n- |");
    expect(show(continueList(at("  3. three|"))!)).toBe("  3. three\n  4. |");
    expect(show(continueList(at("- [x] done|"))!)).toBe("- [x] done\n- [ ] |");
  });
  test("ends the list on an empty item", () => {
    expect(show(continueList(at("- one\n- |"))!)).toBe("- one\n|");
  });
  test("keeps an item's text when the caret is before it", () => {
    expect(continueList(at("- |foo"))).toBeNull();
    expect(continueList(at("1. |foo"))).toBeNull();
    expect(continueList(at("> |foo"))).toBeNull();
    expect(continueList(at("|- foo"))).toBeNull();
  });
  test("splits an item at the caret", () => {
    expect(show(continueList(at("- fo|o"))!)).toBe("- fo\n- |o");
  });
  test("ends the list on an empty item before other lines", () => {
    expect(show(continueList(at("- one\n- |\nnext"))!)).toBe("- one\n|\nnext");
  });
  test("leaves other lines alone", () => {
    expect(continueList(at("text|"))).toBeNull();
  });
});

test("indentLines", () => {
  expect(show(indentLines(at("- a|"), false))).toBe("  - a|");
  expect(show(indentLines(at("  - a|"), true))).toBe("- a|");
});

test("imageName makes safe, unique names", () => {
  expect(imageName("My Chart.PNG", new Set())).toBe("images/my-chart.png");
  expect(imageName("chart.png", new Set(["images/chart.png"]))).toBe("images/chart-2.png");
  expect(imageName("pasted", new Set(), "image/jpeg")).toBe("images/pasted.jpg");
});

test("imageCandidates resolves as the renderer does", () => {
  expect(imageCandidates("plan/phase-1", "images/a.png")).toEqual([
    "plan/images/a.png",
    "images/a.png",
  ]);
  expect(imageCandidates("index", "../a.png")).toEqual([]);
  expect(imageCandidates("plan/a", "../b.png")).toEqual(["b.png"]);
  expect(imageCandidates("index", "https://x/a.png")).toEqual([]);
  expect(imageCandidates("index", "data:image/png;base64,AA")).toEqual([]);
});

test("pagePath normalises as the server does", () => {
  expect(pagePath("Plan/Phase 1.md")).toBe("plan/phase-1");
  expect(pagePath("  ")).toBe("index");
});
