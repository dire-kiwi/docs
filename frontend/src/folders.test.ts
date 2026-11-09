import { expect, test } from "vite-plus/test";

import { closedFolders } from "./folders.ts";

test("remembers closed folders that are still there", () => {
  const stored = JSON.stringify(["mine:docs", "mine:gone", 3]);
  expect([...closedFolders(stored, ["mine:docs", "mine:docs/plans"])]).toEqual(["mine:docs"]);
});

test("starts with every folder open when nothing is stored", () => {
  expect(closedFolders(null, ["mine:docs"]).size).toBe(0);
  expect(closedFolders("not json", ["mine:docs"]).size).toBe(0);
  expect(closedFolders('{"a":1}', ["mine:docs"]).size).toBe(0);
});

test("keeps folders that aren't shown when the page shows only some", () => {
  const stored = JSON.stringify(["labels:research", "labels:ops"]);
  expect([...closedFolders(stored, ["labels:research"], true)]).toEqual([
    "labels:research",
    "labels:ops",
  ]);
});
