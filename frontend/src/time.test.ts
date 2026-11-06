import { expect, test } from "vite-plus/test";
import { relativeTime } from "./time.ts";

test("formats relative times", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  expect(relativeTime(new Date("2026-01-10T11:59:50Z"), now)).toBe("just now");
  expect(relativeTime(new Date("2026-01-10T11:57:00Z"), now)).toMatch(/3 minutes ago/);
  expect(relativeTime(new Date("2026-01-09T12:00:00Z"), now)).toMatch(/yesterday|1 day ago/);
});
