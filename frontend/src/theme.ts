export type Theme = "light" | "dark";

/** localStorage key of the reader's choice; src/web/theme.js applies it before the page is drawn. */
const KEY = "docs.theme";

/**
 * What the toggle does: show the other theme. It's stored only while it differs
 * from the system's, so a reader who switches back follows their system again.
 */
export function toggled(shown: Theme, system: Theme): { theme: Theme; stored: Theme | null } {
  const theme: Theme = shown === "dark" ? "light" : "dark";
  return { theme, stored: theme === system ? null : theme };
}

/** The light/dark button in the top bar. Pages follow the system until the reader chooses. */
export function initTheme(): void {
  const button = document.querySelector<HTMLButtonElement>(".theme-toggle");
  if (!button) return;
  const root = document.documentElement;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const system = (): Theme => (dark.matches ? "dark" : "light");
  const shown = (): Theme => {
    const chosen = root.dataset.theme;
    return chosen === "light" || chosen === "dark" ? chosen : system();
  };
  const label = (): void => {
    const text = `Switch to the ${shown() === "dark" ? "light" : "dark"} theme`;
    button.setAttribute("aria-label", text);
    button.title = text;
  };
  button.hidden = false;
  label();
  button.addEventListener("click", () => {
    const { stored } = toggled(shown(), system());
    try {
      if (stored) localStorage.setItem(KEY, stored);
      else localStorage.removeItem(KEY);
    } catch {
      // Private browsing: the choice lasts for this page only.
    }
    if (stored) root.dataset.theme = stored;
    else delete root.dataset.theme;
    label();
  });
  dark.addEventListener("change", label);
}
