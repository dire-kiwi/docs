import { expect, test } from "vite-plus/test";
import { toggled } from "./theme.ts";

test("the toggle shows the other theme, and stores it only when it differs from the system's", () => {
  expect(toggled("light", "light")).toEqual({ theme: "dark", stored: "dark" });
  expect(toggled("dark", "light")).toEqual({ theme: "light", stored: null });
  expect(toggled("dark", "dark")).toEqual({ theme: "light", stored: "light" });
  expect(toggled("light", "dark")).toEqual({ theme: "dark", stored: null });
});
