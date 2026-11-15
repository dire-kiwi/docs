import { expect, test } from "vite-plus/test";
import { layoutBubbles } from "./bubbles.ts";

test("bubbles sit at their quotes when there is room", () => {
  expect(layoutBubbles([0, 100, 300], [50, 50, 50])).toEqual([0, 100, 300]);
});

test("overlapping bubbles are pushed down", () => {
  expect(layoutBubbles([0, 20, 40], [50, 50, 50])).toEqual([0, 58, 116]);
});

test("the active bubble stays at its quote and pushes earlier ones up", () => {
  expect(layoutBubbles([0, 20, 40], [50, 50, 50], 1)).toEqual([-38, 20, 78]);
});

test("comments whose quote is gone go after the others", () => {
  expect(layoutBubbles([NaN, 100], [50, 50])).toEqual([0, 100]);
  expect(layoutBubbles([100, NaN], [50, 50])).toEqual([100, 158]);
});
