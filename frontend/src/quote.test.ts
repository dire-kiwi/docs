import { expect, test } from "vite-plus/test";
import { findQuote } from "./quote.ts";

test("finds a unique quote", () => {
  expect(findQuote("the quick brown fox", "brown")).toBe(10);
});

test("uses context to pick between repeated quotes", () => {
  const text = "Phase 1: ship it. Phase 2: ship it. Phase 3: ship it.";
  expect(findQuote(text, "ship it", "Phase 2: ", ". Phase 3")).toBe(27);
  expect(findQuote(text, "ship it", "Phase 3: ", ".")).toBe(45);
});

test("returns -1 when the quote is gone", () => {
  expect(findQuote("rewritten page", "old sentence", "", "")).toBe(-1);
  expect(findQuote("anything", "")).toBe(-1);
});
