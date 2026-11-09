// Compiled (not run) by test.sh: the published types accept the documented calls.
import init, { extractInlineImages, imageLimits, labelTree, navTree, normalizeFolder, normalizeLabels, render, resolveLink, toolDefinitions, validatePage, validatePages } from "@dire-kiwi/docs-render";

await init();
const full = render("x", "mdx", { pagePath: "plan/a", baseUrl: "/d/x/", answers: { q: 1 } });
const short = render("x", "md");
const html: string = full.html + short.html;
const fields: string[] = full.fields.map((f) => f.name);
const page = validatePage("x");
const typed = validatePage("x", "mdx", "plan/a");
const title: string = page.title + typed.format;
const { pages, warnings } = validatePages([{ path: "a", content: "x", format: "md" }]);
const nav: (string | null)[] = navTree([["index", "Home"]]).map((n) => n.page);
const suffix: string | undefined = resolveLink("a", "b")?.suffix;
const schema: Record<string, unknown> = toolDefinitions()[0].inputSchema;
const folder: string = normalizeFolder("docs/plans");
const labels: string[] = normalizeLabels(["research/ai"]);
const counts: number[] = labelTree([labels]).map((n) => n.documents + n.docs.length);
const extracted: string = extractInlineImages("x", "md").images.map((i) => i.name + i.data).join() + extractInlineImages("x", "mdx", "a").content;
const limit: number = imageLimits().maxImageBytes;
const withImages = render("x", "md", { pagePath: "a", baseUrl: "/", images: { "a.png": "/a.avif" } }).imageSrcs;
export { extracted, limit, withImages };
export { html, fields, title, pages, warnings, nav, suffix, schema, folder, labels, counts };
