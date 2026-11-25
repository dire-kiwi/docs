/** The page menu collapses into a toggle on narrow screens. */
export function initNav(): void {
  const button = document.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    button.setAttribute("aria-expanded", String(open));
  });
  // A heading chosen from the open menu is on the page behind it: close the menu to show it.
  document.querySelector(".doc-nav")?.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('a[href^="#"]')) return;
    document.body.classList.remove("nav-open");
    button.setAttribute("aria-expanded", "false");
  });
}
