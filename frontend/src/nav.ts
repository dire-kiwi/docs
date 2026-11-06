/** The page menu collapses into a toggle on narrow screens. */
export function initNav(): void {
  const button = document.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    button.setAttribute("aria-expanded", String(open));
  });
}
