const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 minutes ago", "yesterday", … */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Show server-rendered UTC times relative to now, with the local time as a tooltip. */
export function initTimes(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
    const date = new Date(el.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    el.textContent = relativeTime(date);
    el.title = date.toLocaleString();
  }
}
