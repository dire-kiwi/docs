//! CommonMark / GFM / MDX → HTML.
//!
//! Sources are parsed with `markdown` (markdown-rs) into mdast and rendered
//! here so MDX JSX elements can be mapped onto a fixed set of server-rendered
//! components (see [`crate::components`]). No JavaScript in the source is
//! ever executed. The final HTML always goes through an allowlist sanitizer.

use std::collections::HashMap;
use std::sync::OnceLock;

use markdown::mdast::{AlignKind, AttributeContent, AttributeValue, Node};
use markdown::{Constructs, ParseOptions};
use serde_json::Value;

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Md,
    Mdx,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
            "md" | "markdown" | "gfm" | "commonmark" => Some(Format::Md),
            "mdx" => Some(Format::Mdx),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Md => "md",
            Format::Mdx => "mdx",
        }
    }
}

pub struct Options<'a> {
    /// Path of the page being rendered, used to resolve relative links.
    pub page_path: &'a str,
    /// URL prefix for pages of this document version, ending in `/`.
    pub base_url: &'a str,
    /// Saved answers of the current viewer, keyed by field name.
    pub answers: &'a HashMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TocEntry {
    pub depth: u8,
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FieldInfo {
    pub name: String,
    pub kind: &'static str,
    pub label: String,
}

#[derive(Debug, Default)]
pub struct Rendered {
    pub html: String,
    pub toc: Vec<TocEntry>,
    pub has_h1: bool,
    pub fields: Vec<FieldInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    pub order: Option<i64>,
}

pub fn parse(source: &str, format: Format) -> Result<Node, String> {
    let gfm = Constructs::gfm();
    let constructs = match format {
        Format::Md => Constructs {
            frontmatter: true,
            ..gfm
        },
        Format::Mdx => Constructs {
            frontmatter: true,
            // MDX turns these off because `<` and `{` mean JSX / expressions.
            autolink: false,
            code_indented: false,
            html_flow: false,
            html_text: false,
            mdx_esm: true,
            mdx_expression_flow: true,
            mdx_expression_text: true,
            mdx_jsx_flow: true,
            mdx_jsx_text: true,
            ..gfm
        },
    };
    let options = ParseOptions {
        constructs,
        ..ParseOptions::gfm()
    };
    markdown::to_mdast(source, &options).map_err(|e| e.to_string())
}

/// Title and ordering hints: YAML frontmatter `title:` / `order:`, else the first `# heading`.
pub fn meta(root: &Node) -> Meta {
    let mut meta = Meta::default();
    let children = root.children().map(Vec::as_slice).unwrap_or_default();
    for child in children {
        if let Node::Yaml(y) = child {
            for line in y.value.lines() {
                let Some((k, v)) = line.split_once(':') else { continue };
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                match k.trim() {
                    "title" if !v.is_empty() => meta.title = Some(v),
                    "order" => meta.order = v.parse().ok(),
                    _ => {}
                }
            }
        }
    }
    if meta.title.is_none() {
        meta.title = children.iter().find_map(|n| match n {
            Node::Heading(h) if h.depth == 1 => Some(n.to_string()),
            _ => None,
        });
    }
    meta
}

pub fn render(source: &str, format: Format, opts: &Options) -> Result<Rendered, String> {
    let root = parse(source, format)?;
    Ok(render_tree(&root, opts))
}

pub fn render_tree(root: &Node, opts: &Options) -> Rendered {
    let mut r = Renderer {
        out: String::with_capacity(4096),
        opts,
        defs: HashMap::new(),
        footnote_defs: HashMap::new(),
        footnote_order: Vec::new(),
        ids: HashMap::new(),
        res: Rendered::default(),
    };
    r.collect_definitions(root);
    r.node(root);
    r.footnotes();
    let mut res = r.res;
    res.html = sanitize(&r.out);
    res
}

struct Renderer<'a> {
    out: String,
    opts: &'a Options<'a>,
    defs: HashMap<String, (String, Option<String>)>,
    footnote_defs: HashMap<String, Vec<Node>>,
    footnote_order: Vec<String>,
    ids: HashMap<String, usize>,
    res: Rendered,
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
        } else if (c == ' ' || c == '-') && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

impl<'a> Renderer<'a> {
    fn push(&mut self, s: &str) {
        self.out.push_str(s);
    }

    fn text(&mut self, s: &str) {
        let e = escape(s);
        self.out.push_str(&e);
    }

    fn warn(&mut self, msg: String) {
        if !self.res.warnings.contains(&msg) {
            self.res.warnings.push(msg);
        }
    }

    fn unique_id(&mut self, base: &str) -> String {
        let base = if base.is_empty() {
            "section".to_string()
        } else {
            base.to_string()
        };
        let n = self.ids.entry(base.clone()).or_insert(0);
        *n += 1;
        if *n == 1 { base } else { format!("{base}-{}", *n - 1) }
    }

    fn collect_definitions(&mut self, node: &Node) {
        match node {
            Node::Definition(d) => {
                self.defs
                    .entry(d.identifier.clone())
                    .or_insert((d.url.clone(), d.title.clone()));
            }
            Node::FootnoteDefinition(f) => {
                self.footnote_defs
                    .entry(f.identifier.clone())
                    .or_insert(f.children.clone());
            }
            _ => {}
        }
        if let Some(children) = node.children() {
            for c in children {
                self.collect_definitions(c);
            }
        }
    }

    fn children(&mut self, children: &[Node]) {
        for c in children {
            self.node(c);
        }
    }

    /// List item content in a tight list: paragraphs are not wrapped in `<p>`.
    fn tight_children(&mut self, children: &[Node]) {
        for (i, c) in children.iter().enumerate() {
            match c {
                Node::Paragraph(p) => {
                    if i > 0 {
                        self.push("\n");
                    }
                    self.children(&p.children);
                }
                other => self.node(other),
            }
        }
    }

    fn href(&self, url: &str) -> String {
        match paths::resolve_link(self.opts.page_path, url) {
            Some((path, rest)) => format!("{}{}{}", self.opts.base_url, paths::url_suffix(&path), rest),
            None => url.to_string(),
        }
    }

    fn node(&mut self, node: &Node) {
        match node {
            Node::Root(n) => self.children(&n.children),
            Node::Paragraph(n) => {
                self.push("<p>");
                self.children(&n.children);
                self.push("</p>\n");
            }
            Node::Heading(h) => {
                let text = node.to_string();
                let id = self.unique_id(&slugify(&text));
                if h.depth == 1 {
                    self.res.has_h1 = true;
                }
                if (2..=3).contains(&h.depth) {
                    self.res.toc.push(TocEntry {
                        depth: h.depth,
                        id: id.clone(),
                        text,
                    });
                }
                self.push(&format!("<h{} id=\"{}\">", h.depth, escape(&id)));
                self.children(&h.children);
                self.push(&format!(
                    "<a class=\"anchor\" href=\"#{}\" aria-label=\"Link to this section\">#</a></h{}>\n",
                    escape(&id),
                    h.depth
                ));
            }
            Node::Text(t) => self.text(&t.value),
            Node::Emphasis(n) => {
                self.push("<em>");
                self.children(&n.children);
                self.push("</em>");
            }
            Node::Strong(n) => {
                self.push("<strong>");
                self.children(&n.children);
                self.push("</strong>");
            }
            Node::Delete(n) => {
                self.push("<del>");
                self.children(&n.children);
                self.push("</del>");
            }
            Node::InlineCode(c) => {
                self.push("<code>");
                self.text(&c.value);
                self.push("</code>");
            }
            Node::InlineMath(m) => {
                self.push("<code class=\"math\">");
                self.text(&m.value);
                self.push("</code>");
            }
            Node::Code(c) => {
                match c.lang.as_deref() {
                    Some(lang) => self.push(&format!("<pre><code class=\"language-{}\">", escape(lang))),
                    None => self.push("<pre><code>"),
                }
                self.text(&c.value);
                self.push("</code></pre>\n");
            }
            Node::Math(m) => {
                self.push("<pre><code class=\"math\">");
                self.text(&m.value);
                self.push("</code></pre>\n");
            }
            Node::Break(_) => self.push("<br>\n"),
            Node::ThematicBreak(_) => self.push("<hr>\n"),
            Node::Blockquote(n) => {
                self.push("<blockquote>\n");
                self.children(&n.children);
                self.push("</blockquote>\n");
            }
            Node::List(l) => {
                let tag = if l.ordered { "ol" } else { "ul" };
                let loose = l.spread || l.children.iter().any(|c| matches!(c, Node::ListItem(i) if i.spread));
                let tasks = l
                    .children
                    .iter()
                    .any(|c| matches!(c, Node::ListItem(i) if i.checked.is_some()));
                self.push("<");
                self.push(tag);
                if let Some(start) = l.start.filter(|s| l.ordered && *s != 1) {
                    self.push(&format!(" start=\"{start}\""));
                }
                if tasks {
                    self.push(" class=\"task-list\"");
                }
                self.push(">\n");
                for item in &l.children {
                    let Node::ListItem(item) = item else {
                        self.node(item);
                        continue;
                    };
                    self.push("<li>");
                    if let Some(checked) = item.checked {
                        self.push(if checked {
                            "<input type=\"checkbox\" disabled checked> "
                        } else {
                            "<input type=\"checkbox\" disabled> "
                        });
                    }
                    if loose {
                        self.children(&item.children);
                    } else {
                        self.tight_children(&item.children);
                    }
                    self.push("</li>\n");
                }
                self.push(&format!("</{tag}>\n"));
            }
            Node::ListItem(item) => {
                self.push("<li>");
                self.children(&item.children);
                self.push("</li>\n");
            }
            Node::Link(l) => {
                let href = self.href(&l.url);
                self.link_open(&href, l.title.as_deref());
                self.children(&l.children);
                self.push("</a>");
            }
            Node::LinkReference(l) => match self.defs.get(&l.identifier).cloned() {
                Some((url, title)) => {
                    let href = self.href(&url);
                    self.link_open(&href, title.as_deref());
                    self.children(&l.children);
                    self.push("</a>");
                }
                None => self.children(&l.children),
            },
            Node::Image(i) => self.image(&i.url, &i.alt, i.title.as_deref()),
            Node::ImageReference(i) => {
                if let Some((url, title)) = self.defs.get(&i.identifier).cloned() {
                    self.image(&url, &i.alt, title.as_deref());
                } else {
                    self.text(&i.alt);
                }
            }
            Node::Table(t) => {
                self.push("<div class=\"table-wrap\"><table>\n");
                for (ri, row) in t.children.iter().enumerate() {
                    let Node::TableRow(row) = row else { continue };
                    let cell_tag = if ri == 0 { "th" } else { "td" };
                    if ri == 0 {
                        self.push("<thead>\n");
                    } else if ri == 1 {
                        self.push("<tbody>\n");
                    }
                    self.push("<tr>");
                    for (ci, cell) in row.children.iter().enumerate() {
                        let class = match t.align.get(ci) {
                            Some(AlignKind::Left) => " class=\"align-left\"",
                            Some(AlignKind::Right) => " class=\"align-right\"",
                            Some(AlignKind::Center) => " class=\"align-center\"",
                            _ => "",
                        };
                        self.push(&format!("<{cell_tag}{class}>"));
                        if let Some(children) = cell.children() {
                            self.children(children);
                        }
                        self.push(&format!("</{cell_tag}>"));
                    }
                    self.push("</tr>\n");
                    if ri == 0 {
                        self.push("</thead>\n");
                    }
                }
                if t.children.len() > 1 {
                    self.push("</tbody>\n");
                }
                self.push("</table></div>\n");
            }
            Node::TableRow(_) | Node::TableCell(_) => {}
            Node::Html(h) => self.push(&h.value),
            Node::FootnoteReference(f) => {
                let n = match self.footnote_order.iter().position(|i| *i == f.identifier) {
                    Some(p) => p + 1,
                    None => {
                        self.footnote_order.push(f.identifier.clone());
                        self.footnote_order.len()
                    }
                };
                let id = escape(&slugify(&f.identifier));
                self.push(&format!(
                    "<sup class=\"fnref\"><a href=\"#fn-{id}\" id=\"fnref-{id}\">{n}</a></sup>"
                ));
            }
            Node::FootnoteDefinition(_) | Node::Definition(_) => {}
            Node::Yaml(_) | Node::Toml(_) => {}
            Node::MdxjsEsm(_) => {
                self.warn("import/export statements are ignored".into());
            }
            Node::MdxFlowExpression(e) => self.expression(&e.value),
            Node::MdxTextExpression(e) => self.expression(&e.value),
            Node::MdxJsxFlowElement(e) => {
                self.jsx(e.name.as_deref(), &e.attributes, &e.children, true);
            }
            Node::MdxJsxTextElement(e) => {
                self.jsx(e.name.as_deref(), &e.attributes, &e.children, false);
            }
        }
    }

    fn link_open(&mut self, href: &str, title: Option<&str>) {
        self.push(&format!("<a href=\"{}\"", escape(href)));
        if let Some(t) = title {
            self.push(&format!(" title=\"{}\"", escape(t)));
        }
        self.push(">");
    }

    fn image(&mut self, url: &str, alt: &str, title: Option<&str>) {
        self.push(&format!(
            "<img src=\"{}\" alt=\"{}\" loading=\"lazy\"",
            escape(url),
            escape(alt)
        ));
        if let Some(t) = title {
            self.push(&format!(" title=\"{}\"", escape(t)));
        }
        self.push(">");
    }

    fn expression(&mut self, value: &str) {
        let v = value.trim();
        if v.is_empty() || (v.starts_with("/*") && v.ends_with("*/")) {
            return; // MDX comment
        }
        // String literals are the only expressions we can evaluate safely.
        if let Ok(Value::String(s)) = serde_json::from_str::<Value>(v) {
            self.text(&s);
            return;
        }
        self.warn(format!("JavaScript expressions are not evaluated: {{{v}}}"));
    }

    fn footnotes(&mut self) {
        if self.footnote_order.is_empty() {
            return;
        }
        self.push("<section class=\"footnotes\"><ol>\n");
        for ident in self.footnote_order.clone() {
            let id = escape(&slugify(&ident));
            self.push(&format!("<li id=\"fn-{id}\">"));
            if let Some(children) = self.footnote_defs.get(&ident).cloned() {
                self.tight_children(&children);
            }
            self.push(&format!(
                " <a href=\"#fnref-{id}\" aria-label=\"Back to reference\">↩</a></li>\n"
            ));
        }
        self.push("</ol></section>\n");
    }

    fn jsx(&mut self, name: Option<&str>, attributes: &[AttributeContent], children: &[Node], flow: bool) {
        let attrs = Attrs::from_mdx(attributes);
        let Some(name) = name else {
            self.children(children); // fragment
            return;
        };
        if name.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
            self.html_element(name, &attrs, children);
            return;
        }
        match name {
            "Callout" => {
                let kind = attrs.str("type").unwrap_or_else(|| "note".into());
                let kind = match kind.as_str() {
                    "info" | "note" | "tip" | "success" | "warning" | "danger" => kind,
                    _ => "note".into(),
                };
                self.push(&format!("<aside class=\"callout callout-{kind}\">"));
                if let Some(title) = attrs.str("title") {
                    self.push("<p class=\"callout-title\">");
                    self.text(&title);
                    self.push("</p>");
                }
                self.children(children);
                self.push("</aside>\n");
            }
            "Details" => {
                self.push(if attrs.bool("open") {
                    "<details open><summary>"
                } else {
                    "<details><summary>"
                });
                self.text(&attrs.str("summary").unwrap_or_else(|| "Details".into()));
                self.push("</summary>\n");
                self.children(children);
                self.push("</details>\n");
            }
            "TextInput" | "TextArea" | "Select" | "RadioGroup" | "CheckboxGroup" | "Checkbox" | "Scale"
            | "Approval" => self.field(name, &attrs, children),
            _ => {
                self.warn(format!(
                    "unknown component <{name}>; see the component list for what is available"
                ));
                self.push(&format!(
                    "<div class=\"unknown-component\" title=\"Unknown component\">&lt;{}&gt;</div>",
                    escape(name)
                ));
                if flow {
                    self.children(children);
                } else {
                    self.tight_children(children);
                }
            }
        }
    }

    fn html_element(&mut self, name: &str, attrs: &Attrs, children: &[Node]) {
        // The sanitizer drops anything not on its allowlist; this just maps JSX spellings.
        let tag = escape(name);
        self.push(&format!("<{tag}"));
        for (k, v) in &attrs.0 {
            let key = match k.as_str() {
                "className" => "class",
                "htmlFor" => "for",
                k => k,
            };
            if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                continue;
            }
            match v {
                Value::Bool(true) => self.push(&format!(" {key}")),
                Value::Bool(false) | Value::Null => {}
                Value::String(s) => self.push(&format!(" {key}=\"{}\"", escape(s))),
                other => self.push(&format!(" {key}=\"{}\"", escape(&other.to_string()))),
            }
        }
        self.push(">");
        if !matches!(name, "br" | "hr" | "img" | "wbr") {
            self.children(children);
            self.push(&format!("</{tag}>"));
        }
    }

    fn field(&mut self, component: &str, attrs: &Attrs, children: &[Node]) {
        let kind = match component {
            "TextInput" => "text",
            "TextArea" => "textarea",
            "Select" => "select",
            "RadioGroup" => "radio",
            "CheckboxGroup" => "checkboxes",
            "Checkbox" => "checkbox",
            "Scale" => "scale",
            _ => "approval",
        };
        let label = attrs.str("label").unwrap_or_else(|| match kind {
            "approval" => "Do you approve this?".into(),
            _ => String::new(),
        });
        let name = match attrs.str("name").filter(|n| !n.trim().is_empty()) {
            Some(n) => n.trim().to_string(),
            None if kind == "approval" => "approval".into(),
            None => {
                let generated = match slugify(&label) {
                    s if s.is_empty() => format!("field-{}", self.res.fields.len() + 1),
                    s => s,
                };
                self.warn(format!("<{component}> without a name; using name=\"{generated}\""));
                generated
            }
        };
        if self.res.fields.iter().any(|f| f.name == name) {
            self.warn(format!(
                "duplicate field name \"{name}\"; answers will overwrite each other"
            ));
        }
        self.res.fields.push(FieldInfo {
            name: name.clone(),
            kind,
            label: label.clone(),
        });

        let id = self.unique_id(&format!("f-{}", slugify(&name)));
        let answer = self.opts.answers.get(&name).cloned().unwrap_or(Value::Null);
        let required = attrs.bool("required");
        let placeholder = attrs
            .str("placeholder")
            .map(|p| format!(" placeholder=\"{}\"", escape(&p)))
            .unwrap_or_default();
        let req = if required { " required" } else { "" };

        self.push(&format!(
            "<div class=\"field field-{kind}\" data-field=\"{}\" data-kind=\"{kind}\">",
            escape(&name)
        ));
        let label_tag = if matches!(kind, "text" | "textarea" | "select") {
            "label"
        } else {
            "div"
        };
        if kind != "checkbox" {
            self.push(&format!("<{label_tag} class=\"field-label\" id=\"{id}-label\""));
            if label_tag == "label" {
                self.push(&format!(" for=\"{id}\""));
            }
            self.push(">");
            self.text(&label);
            if required {
                self.push("<span class=\"field-required\" title=\"Required\">*</span>");
            }
            self.push(&format!("</{label_tag}>"));
        }
        if !children.is_empty() {
            self.push("<div class=\"field-help\">");
            self.tight_children(children);
            self.push("</div>");
        } else if let Some(help) = attrs.str("help") {
            self.push("<div class=\"field-help\">");
            self.text(&help);
            self.push("</div>");
        }

        let answer_str = match &answer {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        match kind {
            "text" => self.push(&format!(
                "<input type=\"text\" id=\"{id}\" name=\"{id}\" value=\"{}\"{placeholder}{req}>",
                escape(&answer_str)
            )),
            "textarea" => {
                let rows = attrs.num("rows").unwrap_or(4).clamp(1, 40);
                self.push(&format!(
                    "<textarea id=\"{id}\" name=\"{id}\" rows=\"{rows}\"{placeholder}{req}>"
                ));
                self.text(&answer_str);
                self.push("</textarea>");
            }
            "select" => {
                self.push(&format!("<select id=\"{id}\" name=\"{id}\"{req}>"));
                self.push("<option value=\"\">Choose…</option>");
                for (value, text) in attrs.options("options") {
                    let sel = if value == answer_str { " selected" } else { "" };
                    self.push(&format!("<option value=\"{}\"{sel}>", escape(&value)));
                    self.text(&text);
                    self.push("</option>");
                }
                self.push("</select>");
                self.empty_options_warning(component, attrs);
            }
            "radio" | "checkboxes" => {
                let input_type = if kind == "radio" { "radio" } else { "checkbox" };
                let chosen: Vec<String> = match &answer {
                    Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                    Value::String(s) => vec![s.clone()],
                    _ => vec![],
                };
                let role = if kind == "radio" { "radiogroup" } else { "group" };
                self.push(&format!(
                    "<div class=\"options\" role=\"{role}\" aria-labelledby=\"{id}-label\">"
                ));
                for (value, text) in attrs.options("options") {
                    let checked = if chosen.contains(&value) { " checked" } else { "" };
                    self.push(&format!(
                        "<label class=\"option\"><input type=\"{input_type}\" name=\"{id}\" value=\"{}\"{checked}> <span>",
                        escape(&value)
                    ));
                    self.text(&text);
                    self.push("</span></label>");
                }
                self.push("</div>");
                self.empty_options_warning(component, attrs);
            }
            "checkbox" => {
                let checked = if answer == Value::Bool(true) { " checked" } else { "" };
                self.push(&format!(
                    "<label class=\"option\"><input type=\"checkbox\" id=\"{id}\" name=\"{id}\"{checked}> <span>"
                ));
                self.text(&label);
                self.push("</span></label>");
            }
            "scale" => {
                let min = attrs.num("min").unwrap_or(1);
                let max = attrs.num("max").unwrap_or(5).max(min).min(min + 20);
                self.push(&format!(
                    "<div class=\"scale\" role=\"radiogroup\" aria-labelledby=\"{id}-label\">"
                ));
                if let Some(l) = attrs.str("minLabel") {
                    self.push("<span class=\"scale-end\">");
                    self.text(&l);
                    self.push("</span>");
                }
                for v in min..=max {
                    let checked = if answer_str == v.to_string() { " checked" } else { "" };
                    self.push(&format!(
                        "<label class=\"scale-point\"><input type=\"radio\" name=\"{id}\" value=\"{v}\"{checked}><span>{v}</span></label>"
                    ));
                }
                if let Some(l) = attrs.str("maxLabel") {
                    self.push("<span class=\"scale-end\">");
                    self.text(&l);
                    self.push("</span>");
                }
                self.push("</div>");
            }
            _ => {
                // Approval: decision + optional comment, stored as {"decision", "comment"}.
                let decision = answer.get("decision").and_then(Value::as_str).unwrap_or("");
                let comment = answer.get("comment").and_then(Value::as_str).unwrap_or("");
                self.push(&format!(
                    "<div class=\"options approval\" role=\"radiogroup\" aria-labelledby=\"{id}-label\">"
                ));
                for (value, text) in [
                    ("approve", "Approve"),
                    ("changes", "Request changes"),
                    ("reject", "Reject"),
                ] {
                    let checked = if decision == value { " checked" } else { "" };
                    self.push(&format!(
                        "<label class=\"option option-{value}\"><input type=\"radio\" name=\"{id}\" value=\"{value}\"{checked}> <span>{text}</span></label>"
                    ));
                }
                self.push("</div>");
                self.push(&format!(
                    "<textarea class=\"approval-comment\" id=\"{id}-comment\" rows=\"3\" placeholder=\"Comments (optional)\" aria-label=\"Comments\">"
                ));
                self.text(comment);
                self.push("</textarea>");
            }
        }
        self.push("<div class=\"field-status\" aria-live=\"polite\"></div></div>\n");
    }

    fn empty_options_warning(&mut self, component: &str, attrs: &Attrs) {
        if attrs.options("options").is_empty() {
            self.warn(format!("<{component}> has no options; pass options={{[\"A\", \"B\"]}}"));
        }
    }
}

/// JSX attributes with values reduced to JSON (`a="x"` → "x", `b={2}` → 2, `c` → true).
struct Attrs(Vec<(String, Value)>);

impl Attrs {
    fn from_mdx(attributes: &[AttributeContent]) -> Self {
        let mut out = Vec::new();
        for a in attributes {
            let AttributeContent::Property(p) = a else { continue };
            let v = match &p.value {
                None => Value::Bool(true),
                Some(AttributeValue::Literal(s)) => Value::String(s.clone()),
                Some(AttributeValue::Expression(e)) => parse_expression(&e.value),
            };
            out.push((p.name.clone(), v));
        }
        Attrs(out)
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn str(&self, key: &str) -> Option<String> {
        match self.get(key)? {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    }

    fn bool(&self, key: &str) -> bool {
        match self.get(key) {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s != "false",
            _ => false,
        }
    }

    fn num(&self, key: &str) -> Option<i64> {
        match self.get(key)? {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// `options={["a", "b"]}`, `options={[{"value": "a", "label": "A"}]}` or `options="a, b"`.
    fn options(&self, key: &str) -> Vec<(String, String)> {
        let scalar = |v: &Value| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        };
        match self.get(key) {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    Value::Object(o) => {
                        let value = o
                            .get("value")
                            .and_then(scalar)
                            .or_else(|| o.get("label").and_then(scalar))?;
                        let label = o.get("label").and_then(scalar).unwrap_or_else(|| value.clone());
                        Some((value, label))
                    }
                    v => scalar(v).map(|s| (s.clone(), s)),
                })
                .collect(),
            Some(Value::String(s)) => s
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| (s.to_string(), s.to_string()))
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// Evaluate a JSX attribute expression as JSON, tolerating JS-style quotes
/// and unquoted object keys. Anything else is kept as its source text.
fn parse_expression(src: &str) -> Value {
    let src = src.trim();
    if let Ok(v) = serde_json::from_str(src) {
        return v;
    }
    let mut fixed = String::with_capacity(src.len());
    let mut in_str: Option<char> = None;
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match in_str {
            Some(q) => {
                if c == '\\' && i + 1 < chars.len() {
                    fixed.push(c);
                    fixed.push(chars[i + 1]);
                    i += 1;
                } else if c == q {
                    fixed.push('"');
                    in_str = None;
                } else if c == '"' {
                    fixed.push_str("\\\"");
                } else {
                    fixed.push(c);
                }
            }
            None => {
                if c == '\'' || c == '"' || c == '`' {
                    in_str = Some(c);
                    fixed.push('"');
                } else if (c.is_ascii_alphabetic() || c == '_') && {
                    // bare object key: identifier followed by ':'
                    let rest: String = chars[i..].iter().collect();
                    let ident_len = rest
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                        .count();
                    rest[ident_len..].trim_start().starts_with(':')
                } {
                    let ident: String = chars[i..]
                        .iter()
                        .take_while(|c| c.is_ascii_alphanumeric() || **c == '_')
                        .collect();
                    fixed.push('"');
                    fixed.push_str(&ident);
                    fixed.push('"');
                    i += ident.chars().count();
                    continue;
                } else {
                    fixed.push(c);
                }
            }
        }
        i += 1;
    }
    // Trailing commas are legal JS but not JSON.
    let fixed = fixed
        .replace(",]", "]")
        .replace(", ]", "]")
        .replace(",}", "}")
        .replace(", }", "}");
    serde_json::from_str(&fixed).unwrap_or_else(|_| Value::String(src.to_string()))
}

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static CELL: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.add_tags([
            "input", "textarea", "select", "option", "label", "aside", "section", "fieldset", "legend",
        ])
        .add_generic_attributes([
            "class",
            "id",
            "title",
            "role",
            "aria-live",
            "aria-label",
            "aria-labelledby",
        ])
        .add_generic_attribute_prefixes(["data-"])
        .add_tag_attributes(
            "input",
            [
                "type",
                "name",
                "value",
                "checked",
                "disabled",
                "placeholder",
                "required",
            ],
        )
        .add_tag_attributes("textarea", ["name", "rows", "placeholder", "required"])
        .add_tag_attributes("select", ["name", "required"])
        .add_tag_attributes("option", ["value", "selected"])
        .add_tag_attributes("label", ["for"])
        .add_tag_attributes("img", ["loading", "width", "height"])
        .add_tag_attributes("details", ["open"])
        .add_tag_attributes("ol", ["start"]);
        b
    })
}

pub fn sanitize(html: &str) -> String {
    sanitizer().clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(src: &str, format: Format) -> Rendered {
        let answers = HashMap::new();
        let opts = Options {
            page_path: "plan/phase-1",
            base_url: "/d/x/",
            answers: &answers,
        };
        render(src, format, &opts).unwrap()
    }

    #[test]
    fn renders_gfm() {
        let r = html(
            "# Title\n\nSome *em* and ~~del~~.\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\nHi[^1]\n\n[^1]: Note.\n",
            Format::Md,
        );
        assert!(r.has_h1);
        assert!(r.html.contains("<h1 id=\"title\">"));
        assert!(r.html.contains("<del>del</del>"));
        assert!(r.html.contains("<th class=\"align-left\">a</th>"));
        assert!(
            r.html.contains("<input type=\"checkbox\" disabled=\"\" checked=\"\">"),
            "{}",
            r.html
        );
        assert!(r.html.contains("id=\"fn-1\""));
    }

    #[test]
    fn strips_dangerous_html() {
        let r = html(
            "<script>alert(1)</script>\n\n<a href=\"javascript:alert(1)\" onclick=\"x()\">x</a>\n\n<form action=\"https://evil\"><input name=a></form>",
            Format::Md,
        );
        assert!(!r.html.contains("script"));
        assert!(!r.html.contains("javascript:"));
        assert!(!r.html.contains("onclick"));
        assert!(!r.html.contains("<form"));
    }

    #[test]
    fn rewrites_relative_links() {
        let r = html(
            "[next](phase-2.md#goals) [up](../index.md) [ext](https://example.com)",
            Format::Md,
        );
        assert!(r.html.contains("href=\"/d/x/plan/phase-2#goals\""), "{}", r.html);
        assert!(r.html.contains("href=\"/d/x/\""));
        assert!(r.html.contains("href=\"https://example.com\""));
    }

    #[test]
    fn renders_mdx_components() {
        let src = r#"---
title: My plan
order: 2
---

<Callout type="warning" title="Heads up">Careful **now**.</Callout>

<RadioGroup name="db" label="Database" options={['SQLite', 'Postgres']} required />

<TextArea name="notes" label="Anything else?" rows={3} />

<Approval />

{/* a comment */}
"#;
        let root = parse(src, Format::Mdx).unwrap();
        assert_eq!(
            meta(&root),
            Meta {
                title: Some("My plan".into()),
                order: Some(2)
            }
        );
        let r = html(src, Format::Mdx);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert!(r.html.contains("callout-warning"));
        assert!(r.html.contains("<strong>now</strong>"));
        assert!(r.html.contains("data-field=\"db\""));
        assert!(r.html.contains("value=\"Postgres\""));
        assert!(r.html.contains("data-kind=\"approval\""));
        let names: Vec<_> = r.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["db", "notes", "approval"]);
    }

    #[test]
    fn prefills_answers() {
        let mut answers = HashMap::new();
        answers.insert("db".to_string(), Value::String("Postgres".into()));
        answers.insert("ok".to_string(), Value::Bool(true));
        let opts = Options {
            page_path: "index",
            base_url: "/d/x/",
            answers: &answers,
        };
        let r = render(
            "<Select name=\"db\" options=\"SQLite, Postgres\" />\n\n<Checkbox name=\"ok\" label=\"OK\" />",
            Format::Mdx,
            &opts,
        )
        .unwrap();
        assert!(
            r.html.contains("<option value=\"Postgres\" selected=\"\">"),
            "{}",
            r.html
        );
        assert!(r.html.contains("checked"));
    }

    #[test]
    fn warns_about_unknown_components_and_expressions() {
        let r = html("<Chart data={x} />\n\n{1 + 1}", Format::Mdx);
        assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
        assert!(r.html.contains("unknown-component"));
    }

    #[test]
    fn mdx_syntax_errors_are_reported() {
        let answers = HashMap::new();
        let opts = Options {
            page_path: "index",
            base_url: "/d/x/",
            answers: &answers,
        };
        assert!(render("<Callout>\n\nunclosed", Format::Mdx, &opts).is_err());
    }

    #[test]
    fn parses_js_style_expressions() {
        assert_eq!(parse_expression("['a', 'b',]"), serde_json::json!(["a", "b"]));
        assert_eq!(
            parse_expression("[{value: 'a', label: \"It's A\"}]"),
            serde_json::json!([{"value": "a", "label": "It's A"}])
        );
        assert_eq!(parse_expression("3"), serde_json::json!(3));
        assert_eq!(parse_expression("foo()"), serde_json::json!("foo()"));
    }
}
