/**
 * The folders (or labels) that were closed last time. Ones that are gone are
 * dropped, unless the page shows only `partial`ly what is there (a label filter).
 */
export function closedFolders(
  stored: string | null,
  present: string[],
  partial = false,
): Set<string> {
  let saved: unknown;
  try {
    saved = JSON.parse(stored ?? "[]");
  } catch {
    saved = [];
  }
  const keys = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  return new Set(partial ? keys : keys.filter((k) => present.includes(k)));
}

/**
 * Folders and labels on the home page stay open or closed the way the reader left
 * them. Each tree (`data-tree-store`, its localStorage key) is remembered separately.
 */
export function initFolders(): void {
  for (const tree of document.querySelectorAll<HTMLElement>("[data-tree-store]")) {
    const storageKey = tree.dataset.treeStore ?? "";
    const folders = [...tree.querySelectorAll<HTMLDetailsElement>("details[data-folder-key]")];
    if (folders.length === 0) continue;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(storageKey);
    } catch {
      // Storage can be off; folders then just start open.
    }
    const closed = closedFolders(
      stored,
      folders.map((d) => d.dataset.folderKey ?? ""),
      tree.dataset.treePartial !== undefined,
    );
    for (const d of folders) {
      const key = d.dataset.folderKey ?? "";
      if (closed.has(key)) d.open = false;
      d.addEventListener("toggle", () => {
        if (d.open) closed.delete(key);
        else closed.add(key);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...closed]));
        } catch {
          // Not remembered; nothing else to do.
        }
      });
    }
  }
}
