// Checks the packed @dire-kiwi/docs-render against the native renderer.
// Run through test.sh, which installs the tarball and provides NATIVE_JSON and FIXTURES.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import * as docs from "@dire-kiwi/docs-render";
import init from "@dire-kiwi/docs-render";

const native = JSON.parse(readFileSync(process.env.NATIVE_JSON, "utf8"));
const dir = process.env.FIXTURES;
const answers = JSON.parse(readFileSync(join(dir, "answers.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

const attempt = (f) => {
  try {
    return f();
  } catch (e) {
    assert.equal(typeof e, "string", "errors are thrown as strings");
    return { error: e };
  }
};

test("node entry works without init, and init() is a no-op", async () => {
  await init();
  assert.equal(docs.normalizePath("./A b.md"), "a-b");
});

const files = readdirSync(dir).filter((f) => /\.mdx?$/.test(f)).sort();
for (const name of files) {
  test(`fixture ${name} matches native`, () => {
    const expected = native.fixtures[name];
    const source = readFileSync(join(dir, name), "utf8");
    const format = expected.format;
    const opts = { pagePath: "plan/phase-1", baseUrl: "/d/x/", answers };
    assert.deepEqual(attempt(() => docs.render(source, format, opts)), expected.render);
    assert.deepEqual(attempt(() => docs.meta(source, format)), expected.meta);
    // validatePage infers the format from the content like publish_document does.
    const v = attempt(() => docs.validatePage(source, undefined, `plan/${name}`));
    const fromNative = expected.validate.error
      ? expected.validate
      : { ...expected.validate.pages[0], warnings: expected.validate.warnings.map((w) => w.warning) };
    assert.deepEqual(v, fromNative);
  });
}

test("paths match native", () => {
  assert.deepEqual(
    cases.paths.map((p) => attempt(() => ({ ok: docs.normalizePath(p) }))),
    native.paths,
  );
  assert.deepEqual(
    cases.folders.map((f) => attempt(() => ({ ok: docs.normalizeFolder(f) }))),
    native.folders,
  );
  assert.equal(docs.normalizeFolder(" docs//plans/ "), "docs/plans");
  assert.deepEqual(
    cases.labels.map((l) => attempt(() => ({ ok: docs.normalizeLabel(l) }))),
    native.labels,
  );
  assert.deepEqual(docs.labelTree(cases.labelTree), native.labelTree);
  assert.deepEqual(docs.normalizeLabels(["Research", "research ", "x/ y"]), ["Research", "x/y"]);
  assert.equal(docs.labelMatches("Research/AI", "research"), true);
  assert.equal(docs.labelMatches("researchers", "research"), false);
  assert.equal(docs.withKnownCase("research/x", ["Research/AI"]), "Research/x");
  assert.deepEqual(
    cases.links.map(([from, href]) => docs.resolveLink(from, href)),
    native.links,
  );
  assert.deepEqual(cases.titles.map(docs.titleFromPath), native.titles);
  assert.deepEqual(cases.titles.map(docs.urlSuffix), native.suffixes);
  assert.deepEqual(cases.suffixes.map(docs.pathCandidates), native.candidates);
  assert.deepEqual(docs.navTree(cases.nav), native.nav);
});

test("publish checks match native", () => {
  assert.deepEqual(
    cases.publish.map((pages) => attempt(() => docs.validatePages(pages))),
    native.publish,
  );
});

test("sanitize, references and tool definitions match native", () => {
  assert.deepEqual(cases.html.map(docs.sanitize), native.sanitize);
  assert.equal(docs.componentsReference(), native.componentsReference);
  assert.deepEqual(docs.toolDefinitions(), native.toolDefinitions);
  const tools = Object.fromEntries(docs.toolDefinitions().map((t) => [t.name, t]));
  assert.deepEqual(tools.move_document.inputSchema.required, ["slug", "folder"]);
  assert.deepEqual(tools.set_document_labels.inputSchema.required, ["document", "labels"]);
  assert.equal(tools.publish_document.inputSchema.properties.labels.type, "array");
  assert.equal(tools.list_documents.inputSchema.properties.label.type, "string");
  assert.ok(tools.list_labels);
  assert.equal(tools.publish_document.inputSchema.properties.folder.type, "string");
  assert.match(docs.serverInstructions(), /`folder`/);
  assert.equal(docs.serverInstructions(), native.serverInstructions);
  assert.deepEqual(
    docs.components().map((c) => c.name),
    ["Callout", "Details", "TextInput", "TextArea", "Select", "RadioGroup", "CheckboxGroup", "Checkbox", "Scale", "Approval"],
  );
});

test("images: inline extraction, names and limits", () => {
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(10)]).toString("base64");
  const source = `![a](data:image/png;base64,${png}) ![b](data:image/png;base64,${png})\n\n\`data:image/png;base64,${png}\`\n`;
  const { content, images } = docs.extractInlineImages(source, "md", "plan/x");
  assert.equal(images.length, 1);
  assert.match(images[0].name, /^images\/inline-[0-9a-f]{16}\.avif$/);
  assert.equal(images[0].data, png);
  assert.equal(content, `![a](${images[0].name}) ![b](${images[0].name})\n\n\`data:image/png;base64,${png}\`\n`);
  // validatePages takes them out too, and doesn't count them towards the page size.
  const big = `![a](data:image/png;base64,${png}${"A".repeat(1_100_000)})`;
  const { pages } = docs.validatePages([{ path: "a", content: big }]);
  assert.match(pages[0].source, /^!\[a\]\(images\/inline-/);
  assert.deepEqual(pages[0].imageSrcs, [pages[0].source.slice(5, -1)]);
  assert.equal(
    attempt(() => docs.extractInlineImages("![](data:image/svg+xml;base64,PHN2Zy8+)", "md")).error,
    "inline image 1 on page \"index\" is SVG, which isn't supported: images must be PNG, JPEG, WebP, GIF or AVIF",
  );
  assert.equal(docs.normalizeImageName("./images/a.png"), "images/a.png");
  assert.match(attempt(() => docs.normalizeImageName("../a.png")).error, /isn't a relative path/);
  assert.deepEqual(docs.imageCandidates("plan/x", "images/a.png"), ["plan/images/a.png", "images/a.png"]);
  assert.deepEqual(docs.imageLimits(), { maxImageBytes: 512000, maxImages: 200, maxPageBytes: 1000000 });
  assert.equal(
    docs.imageTooLargeError('image "a.png"', 600000),
    'image "a.png" is 600000 bytes after conversion to AVIF, over the limit of 512000 bytes (500 KB): downscale or crop it and publish again',
  );
  const r = docs.render("![a](images/a.png)", "md", { pagePath: "index", baseUrl: "/", images: { "images/a.png": "/i/a.avif" } });
  assert.match(r.html, /src="\/i\/a.avif"/);
  assert.deepEqual(r.imageSrcs, ["images/a.png"]);
  assert.ok(docs.toolDefinitions().find((t) => t.name === "publish_document").inputSchema.properties.images);
});

test("bad arguments throw strings", () => {
  assert.deepEqual(attempt(() => docs.render("x", "html", { pagePath: "index", baseUrl: "/" })), {
    error: 'format must be md or mdx, not "html"',
  });
  assert.match(attempt(() => docs.render("x", "md", {})).error, /^invalid render options/);
});

test("missing arguments use the defaults or throw strings", () => {
  // Options are optional: the page is `index` and the base URL `/`.
  const defaults = docs.render("[next](next.md)", "md");
  assert.deepEqual(defaults, docs.render("[next](next.md)", "md", { pagePath: "index", baseUrl: "/" }));
  assert.deepEqual(docs.render("x", "md", null), docs.render("x", "md", undefined));
  assert.match(defaults.html, /href="\/next"/);
  assert.deepEqual(docs.validatePage("x"), docs.validatePage("x", null, null));

  const fails = {
    "navTree()": () => docs.navTree(),
    "navTree(undefined)": () => docs.navTree(undefined),
    "navTree(fn)": () => docs.navTree(() => 1),
    "validatePages(undefined)": () => docs.validatePages(undefined),
    "validatePages(null)": () => docs.validatePages(null),
    "render()": () => docs.render(),
    "render(src)": () => docs.render("x"),
    "render(src, fmt, {})": () => docs.render("x", "md", {}),
    "meta(undefined, md)": () => docs.meta(undefined, "md"),
    "normalizePath()": () => docs.normalizePath(),
    "normalizePath(3)": () => docs.normalizePath(3),
    "normalizeFolder()": () => docs.normalizeFolder(),
    "normalizeLabel()": () => docs.normalizeLabel(),
    "normalizeLabels()": () => docs.normalizeLabels(),
    "labelTree()": () => docs.labelTree(),
    "resolveLink(from)": () => docs.resolveLink("index"),
    "titleFromPath()": () => docs.titleFromPath(),
    "urlSuffix()": () => docs.urlSuffix(),
    "pathCandidates()": () => docs.pathCandidates(),
    "validatePage()": () => docs.validatePage(),
    "validatePage(src, 3)": () => docs.validatePage("x", 3),
    "sanitize()": () => docs.sanitize(),
  };
  for (const [call, f] of Object.entries(fails)) {
    const { error } = attempt(f);
    assert.equal(typeof error, "string", `${call} throws a string`);
    assert.doesNotMatch(error, /unwrap/, call);
  }
  assert.equal(attempt(() => docs.normalizePath(3)).error, "path must be a string, not number");
  assert.equal(attempt(() => docs.normalizeFolder(null)).error, "folder must be a string, not null");
  assert.equal(attempt(() => docs.render("x")).error, 'format must be "md" or "mdx", not undefined');
  // The instance still works after all that.
  assert.equal(docs.normalizePath("./A b.md"), "a-b");
});

test("the browser build initialises from bytes", async () => {
  const web = await import("@dire-kiwi/docs-render/web");
  const require = createRequire(import.meta.url);
  const wasm = readFileSync(require.resolve("@dire-kiwi/docs-render/docs_render_bg.wasm"));
  await web.default({ module_or_path: wasm });
  assert.equal(web.titleFromPath("plan/phase-1"), "Phase 1");
});

test("the package ships scoped reader styles", () => {
  const require = createRequire(import.meta.url);
  const css = readFileSync(require.resolve("@dire-kiwi/docs-render/styles.css"), "utf8");
  assert.match(css, /@scope \(\.docs-render\)/);
  assert.match(css, /\.doc-content h2/);
  assert.doesNotMatch(css, /:root/);
});
