//! WebAssembly bindings for `docs-render`, published as `@dire-kiwi/docs-render`.
//!
//! Values cross the boundary as JSON (`JSON.parse` / `JSON.stringify`), so
//! numbers, answers and results mean exactly what they do on the server.
//! Errors are thrown as plain strings: the same messages the server reports.

use std::collections::HashMap;

use docs_render::paths::{self, NavNode};
use docs_render::publish::{self, PageInput};
use docs_render::render::{self, Format, Options};
use docs_render::{components, tools};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type Format = "md" | "mdx";

export interface RenderOptions {
  /** Path of the page being rendered (e.g. "plan/phase-1"), used to resolve relative links. */
  pagePath: string;
  /** URL prefix for pages of this document version, ending in "/". */
  baseUrl: string;
  /** Saved answers of the current reader, keyed by field name, to prefill form fields. */
  answers?: Record<string, unknown>;
}

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

export interface FieldInfo {
  name: string;
  /** text, textarea, select, radio, checkboxes, checkbox, scale or approval. */
  kind: string;
  label: string;
}

export interface RenderResult {
  /** Sanitized HTML for the page body. */
  html: string;
  /** h2 and h3 headings, for an "On this page" menu. */
  toc: TocEntry[];
  /** Whether the page has its own `# heading` (otherwise show the title). */
  hasH1: boolean;
  /** Form fields on the page, in order. */
  fields: FieldInfo[];
  /** Problems that did not stop rendering, e.g. unknown components. */
  warnings: string[];
}

export interface PageMeta {
  /** Frontmatter `title:`, else the first `# heading`. */
  title: string | null;
  /** Frontmatter `order:`. */
  order: number | null;
}

export interface ResolvedLink {
  /** Normalised page path the link points to. */
  path: string;
  /** Any `?query#fragment` from the link, including its leading character. */
  suffix: string;
}

export interface NavNode {
  /** Folder or page name (the last path segment). */
  segment: string;
  title: string;
  /** Page path if a page exists for this node. */
  page: string | null;
  children: NavNode[];
}

/** A page as passed to publish_document. */
export interface PageInput {
  path: string;
  content: string;
  /** Defaults to the path's extension, else mdx if the content uses <Components>, else md. */
  format?: string;
  title?: string;
}

export interface ValidPage {
  /** Normalised path. */
  path: string;
  format: Format;
  /** Title for the menu: the given title, frontmatter, first # heading or the path; at most 200 characters. */
  title: string;
  /** Menu position: frontmatter `order`, else the page's index in the input. */
  position: number;
}

export interface ValidatedPage extends ValidPage {
  warnings: string[];
}

export interface PageWarning {
  page: string;
  warning: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ComponentProp {
  name: string;
  doc: string;
}

export interface ComponentDoc {
  name: string;
  summary: string;
  props: ComponentProp[];
  /** Shape of the stored answer, for form fields. */
  answer: string | null;
  /** MDX example. */
  example: string;
}
"#;

type JsResult<T> = Result<T, JsValue>;

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn to_js(v: &Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).expect("serde_json output is valid JSON")
}

fn from_js<T: for<'de> Deserialize<'de>>(v: &JsValue, what: &str) -> JsResult<T> {
    let s: String = js_sys::JSON::stringify(v)
        .map_err(|_| err(format!("{what} must be JSON-serialisable")))?
        .into();
    serde_json::from_str(&s).map_err(|e| err(format!("invalid {what}: {e}")))
}

fn format(s: &str) -> JsResult<Format> {
    Format::parse(s).ok_or_else(|| err(format!("format must be md or mdx, not {s:?}")))
}

/// Render a page to sanitized HTML. Throws if the source cannot be parsed (e.g. broken MDX).
#[wasm_bindgen(unchecked_return_type = "RenderResult")]
pub fn render(
    source: &str,
    #[wasm_bindgen(unchecked_param_type = "Format")] format: &str,
    #[wasm_bindgen(unchecked_param_type = "RenderOptions")] options: JsValue,
) -> JsResult<JsValue> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Opts {
        page_path: String,
        base_url: String,
        #[serde(default)]
        answers: Option<HashMap<String, Value>>,
    }
    let format = self::format(format)?;
    let o: Opts = from_js(&options, "render options")?;
    let answers = o.answers.unwrap_or_default();
    let opts = Options {
        page_path: &o.page_path,
        base_url: &o.base_url,
        answers: &answers,
    };
    let r = render::render(source, format, &opts).map_err(err)?;
    Ok(to_js(&json!({
        "html": r.html,
        "toc": r.toc.iter().map(|t| json!({ "depth": t.depth, "id": t.id, "text": t.text })).collect::<Vec<_>>(),
        "hasH1": r.has_h1,
        "fields": r.fields,
        "warnings": r.warnings,
    })))
}

/// Title and ordering hints from frontmatter or the first `# heading`. Throws if the source cannot be parsed.
#[wasm_bindgen(unchecked_return_type = "PageMeta")]
pub fn meta(source: &str, #[wasm_bindgen(unchecked_param_type = "Format")] format: &str) -> JsResult<JsValue> {
    let tree = render::parse(source, self::format(format)?).map_err(err)?;
    let m = render::meta(&tree);
    Ok(to_js(&json!({ "title": m.title, "order": m.order })))
}

/// Normalise a page path (`./Plan/Phase 1.md` → `plan/phase-1`). Throws a string for invalid paths.
#[wasm_bindgen(js_name = normalizePath)]
pub fn normalize_path(raw: &str) -> JsResult<String> {
    paths::normalize(raw).map_err(err)
}

/// URL suffix, relative to a version base ending in `/`, for a page path (`plan/index` → `plan/`, `index` → ``).
#[wasm_bindgen(js_name = urlSuffix)]
pub fn url_suffix(path: &str) -> String {
    paths::url_suffix(path)
}

/// Page paths a URL suffix may stand for, in the order to try them (the inverse of `urlSuffix`).
#[wasm_bindgen(js_name = pathCandidates)]
pub fn path_candidates(suffix: &str) -> Vec<String> {
    paths::candidates(suffix)
}

/// Resolve a relative link written in page `from` (file semantics). Returns null for absolute URLs,
/// root-relative links and pure fragments, which are left as they are.
#[wasm_bindgen(js_name = resolveLink, unchecked_return_type = "ResolvedLink | null")]
pub fn resolve_link(from: &str, href: &str) -> JsValue {
    match paths::resolve_link(from, href) {
        Some((path, suffix)) => to_js(&json!({ "path": path, "suffix": suffix })),
        None => JsValue::NULL,
    }
}

/// A readable title from the last segment of a path (`plan/phase-1` → `Phase 1`, `index` → `Overview`).
#[wasm_bindgen(js_name = titleFromPath)]
pub fn title_from_path(path: &str) -> String {
    paths::title_from_path(path)
}

fn nav_json(nodes: &[NavNode]) -> Value {
    Value::Array(
        nodes
            .iter()
            .map(|n| {
                json!({
                    "segment": n.segment,
                    "title": n.title,
                    "page": n.page,
                    "children": nav_json(&n.children),
                })
            })
            .collect(),
    )
}

/// Build the nested menu from `[path, title]` pairs in display order.
#[wasm_bindgen(js_name = navTree, unchecked_return_type = "NavNode[]")]
pub fn nav_tree(
    #[wasm_bindgen(unchecked_param_type = "[path: string, title: string][]")] pages: JsValue,
) -> JsResult<JsValue> {
    let pages: Vec<(String, String)> = from_js(&pages, "pages")?;
    Ok(to_js(&nav_json(&paths::nav_tree(&pages))))
}

fn valid_json(p: &publish::ValidPage) -> Value {
    json!({ "path": p.path, "format": p.format.as_str(), "title": p.title, "position": p.position })
}

/// Check one page the way publish_document does. `format` defaults like it does (path extension,
/// then content). Throws the message publish_document would return.
#[wasm_bindgen(js_name = validatePage, unchecked_return_type = "ValidatedPage")]
pub fn validate_page(
    source: &str,
    #[wasm_bindgen(unchecked_param_type = "Format")] format: Option<String>,
    path: Option<String>,
) -> JsResult<JsValue> {
    let input = PageInput {
        path: path.unwrap_or_else(|| "index".into()),
        content: source.into(),
        format,
        title: None,
    };
    let (pages, warnings) = publish::validate_pages(vec![input]).map_err(err)?;
    let mut v = valid_json(&pages[0]);
    v["warnings"] = warnings.into_iter().map(|w| w.warning).collect();
    Ok(to_js(&v))
}

/// Check all pages of a publish the way publish_document does (paths, duplicates, sizes, formats,
/// parse errors). Throws the message publish_document would return.
#[wasm_bindgen(js_name = validatePages, unchecked_return_type = "{ pages: ValidPage[]; warnings: PageWarning[] }")]
pub fn validate_pages(#[wasm_bindgen(unchecked_param_type = "PageInput[]")] pages: JsValue) -> JsResult<JsValue> {
    let input: Vec<PageInput> = from_js(&pages, "pages")?;
    let (pages, warnings) = publish::validate_pages(input).map_err(err)?;
    Ok(to_js(&json!({
        "pages": pages.iter().map(valid_json).collect::<Vec<_>>(),
        "warnings": warnings,
    })))
}

/// Markdown reference for the MDX components: the text of the list_components tool.
#[wasm_bindgen(js_name = componentsReference)]
pub fn components_reference() -> String {
    components::reference()
}

/// The MDX component catalogue, for building a components page.
#[wasm_bindgen(js_name = components, unchecked_return_type = "ComponentDoc[]")]
pub fn component_docs() -> JsValue {
    to_js(&Value::Array(
        components::COMPONENTS
            .iter()
            .map(|c| {
                json!({
                    "name": c.name,
                    "summary": c.summary,
                    "props": c.props.iter().map(|p| json!({ "name": p.name, "doc": p.doc })).collect::<Vec<_>>(),
                    "answer": c.answer,
                    "example": c.example,
                })
            })
            .collect(),
    ))
}

/// The MCP tools the hosted server advertises in tools/list (name, title, description, inputSchema, annotations).
#[wasm_bindgen(js_name = toolDefinitions, unchecked_return_type = "ToolDefinition[]")]
pub fn tool_definitions() -> JsValue {
    to_js(&tools::tool_definitions())
}

/// The `instructions` the hosted MCP server sends in its initialize result.
#[wasm_bindgen(js_name = serverInstructions)]
pub fn server_instructions() -> String {
    tools::INSTRUCTIONS.to_string()
}

/// Run HTML through the same allowlist sanitizer rendered pages go through.
#[wasm_bindgen]
pub fn sanitize(html: &str) -> String {
    render::sanitize(html)
}
