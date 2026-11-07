const STORAGE_KEY = "docs.closedFolders";

/** The folders that were closed last time, without the ones that are gone. */
export function closedFolders(stored: string | null, present: string[]): Set<string> {
  let saved: unknown;
  try {
    saved = JSON.parse(stored ?? "[]");
  } catch {
    saved = [];
  }
  const keys = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  return new Set(keys.filter((k) => present.includes(k)));
}

/** Folders on the home page stay open or closed the way the reader left them. */
export function initFolders(): void {
  const folders = [...document.querySelectorAll<HTMLDetailsElement>("details[data-folder-key]")];
  if (folders.length === 0) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be off; folders then just start open.
  }
  const closed = closedFolders(
    stored,
    folders.map((d) => d.dataset.folderKey ?? ""),
  );
  for (const d of folders) {
    const key = d.dataset.folderKey ?? "";
    if (closed.has(key)) d.open = false;
    d.addEventListener("toggle", () => {
      if (d.open) closed.delete(key);
      else closed.add(key);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...closed]));
      } catch {
        // Not remembered; nothing else to do.
      }
    });
  }
}
