import { expect, test } from "vite-plus/test";
import {
  cssLength,
  mapCssUrls,
  quoteOf,
  selectorSteps,
  shortText,
  shownLength,
  urlSuffix,
} from "./markup.ts";

test("css urls are pointed at the images they name", () => {
  const images = new Map([
    ["images/hero.png", "/d/x/-/images/abc.avif"],
    ["a b.png", "data:image/avif;base64,AA+/=="],
  ]);
  const css = `.a{background:url(images/hero.png) no-repeat}.b{background:url( "a b.png" )}.c{background:url('other.png'), url(https://x/y.png)}`;
  const mapped = mapCssUrls(css, (ref) => images.get(ref));
  expect(mapped).toBe(
    `.a{background:url("/d/x/-/images/abc.avif") no-repeat}.b{background:url("data:image/avif;base64,AA+/==")}.c{background:url('other.png'), url(https://x/y.png)}`,
  );
  // And back, by where they are.
  const names = new Map([...images].map(([name, url]) => [url, name]));
  expect(mapCssUrls(mapped, (ref) => names.get(ref))).toBe(
    `.a{background:url("images/hero.png") no-repeat}.b{background:url("a b.png")}.c{background:url('other.png'), url(https://x/y.png)}`,
  );
});

test("selectors start at the body or the nearest id", () => {
  expect(
    selectorSteps([
      { tag: "body", id: null, index: 2 },
      { tag: "main", id: null, index: 1 },
      { tag: "a", id: null, index: 3 },
    ]),
  ).toBe("body > main:nth-child(1) > a:nth-child(3)");
  expect(
    selectorSteps([
      { tag: "section", id: "pricing", index: 4 },
      { tag: "button", id: null, index: 2 },
    ]),
  ).toBe("#pricing > button:nth-child(2)");
});

test("an element is quoted by its tag and text", () => {
  expect(quoteOf("button", null, "cta  primary", "  Get\n started ")).toBe(
    '<button class="cta primary">Get started</button>',
  );
  expect(
    quoteOf("img", "logo", null, "", { src: "images/logo.png", alt: 'The "logo"', href: null }),
  ).toBe('<img id="logo" src="images/logo.png" alt="The &quot;logo&quot;">');
  expect(quoteOf("p", null, null, "x".repeat(300))).toHaveLength("<p></p>".length + 140);
});

test("text is cut on one line", () => {
  expect(shortText(" a\n\tb  c ", 10)).toBe("a b c");
  expect(shortText("abcdefgh", 5)).toBe("abcd…");
});

test("page urls end as the renderer's do", () => {
  expect(urlSuffix("index")).toBe("");
  expect(urlSuffix("screens/index")).toBe("screens/");
  expect(urlSuffix("screens/home")).toBe("screens/home");
});

test("lengths", () => {
  expect(cssLength("12")).toBe("12px");
  expect(cssLength(" 1.5 ")).toBe("1.5px");
  expect(cssLength("0")).toBe("0");
  expect(cssLength("2rem")).toBe("2rem");
  expect(cssLength("auto")).toBe("auto");
  expect(shownLength("12px")).toBe("12");
  expect(shownLength("12.3456px")).toBe("12.35");
  expect(shownLength("normal")).toBe("normal");
});
