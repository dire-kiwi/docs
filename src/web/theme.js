// Runs before the page is drawn, so a reader who chose light or dark never sees
// the other one first. frontend/src/theme.ts keeps the choice.
try {
  var t = localStorage.getItem("docs.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
