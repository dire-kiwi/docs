//! MCP server over Streamable HTTP (JSON responses, stateless).

use std::collections::HashMap;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::components;
use crate::db::{self, User};
use crate::oauth;
use crate::paths;
use crate::render::{self, Format, Options};
use crate::web::pages::doc_base;

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PAGE_BYTES: usize = 1_000_000;
const MAX_PAGES: usize = 500;

const INSTRUCTIONS: &str = "Docs hosts Markdown documents for people to read and respond to: reports, plans, research. \
Publish with `publish_document` (one or more pages; nested paths like `plan/phase-1` make a nested menu). \
Every publish creates a new version, so you can revise freely. \
Use format \"mdx\" to add form fields (call `list_components` for the list) when you need a decision or input from the reader, \
then call `get_feedback` later to read their answers and any text they selected and commented on. \
Always give the reader the URL returned by `publish_document`.";

pub async fn not_allowed() -> impl IntoResponse {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "This MCP server only accepts POST.",
    )
}

fn unauthorized(state: &AppState, msg: &str) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{}\", scope=\"{}\"",
        oauth::resource_metadata_url(&state.config.base_url),
        oauth::SCOPE
    );
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, challenge)],
        Json(json!({ "error": "invalid_token", "error_description": msg })),
    )
        .into_response()
}

pub async fn handle(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim);
    let Some(token) = token else {
        return unauthorized(&state, "sign in to use this server");
    };
    let user = match db::bearer_user(&state.db, token).await {
        Ok(Some(u)) if state.config.user_allowed(&u.login) => u,
        Ok(Some(_)) => return unauthorized(&state, "this user is no longer allowed to use this site"),
        Ok(None) => return unauthorized(&state, "token is invalid or expired"),
        Err(e) => {
            tracing::error!("{e:#}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Json(rpc_error(Value::Null, -32700, &format!("parse error: {e}"))).into_response(),
    };
    let server = Server {
        state: &state,
        user: &user,
    };
    match msg {
        Value::Array(batch) => {
            let mut out = Vec::new();
            for m in batch {
                if let Some(r) = server.message(m).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        m => match server.message(m).await {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

struct Server<'a> {
    state: &'a AppState,
    user: &'a User,
}

/// A tool failure reported to the model (as opposed to a protocol error).
struct ToolError(String);

impl<E: std::fmt::Display> From<E> for ToolError {
    fn from(e: E) -> Self {
        ToolError(e.to_string())
    }
}

type ToolResult = Result<Value, ToolError>;

fn args<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, ToolError> {
    serde_json::from_value(v).map_err(|e| ToolError(format!("invalid arguments: {e}")))
}

impl Server<'_> {
    async fn message(&self, m: Value) -> Option<Value> {
        let id = m.get("id").cloned();
        let method = m.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(id) = id else {
            return None; // notification (e.g. notifications/initialized) or a response to us
        };
        if method.is_empty() {
            return Some(rpc_error(id, -32600, "invalid request"));
        }
        let params = m.get("params").cloned().unwrap_or(Value::Null);
        let result = match method.as_str() {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if PROTOCOL_VERSIONS.contains(&requested) {
                    requested
                } else {
                    PROTOCOL_VERSIONS[0]
                };
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "docs", "title": "Docs", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tool_definitions() }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let outcome = match name {
                    "list_documents" => self.list_documents().await,
                    "get_document" => self.get_document(arguments).await,
                    "read_page" => self.read_page(arguments).await,
                    "publish_document" => self.publish(arguments).await,
                    "get_feedback" => self.get_feedback(arguments).await,
                    "list_components" => Ok(Value::String(components::reference())),
                    _ => return Some(rpc_error(id, -32602, &format!("unknown tool {name:?}"))),
                };
                match outcome {
                    Ok(Value::String(text)) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Ok(v) => json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }],
                        "structuredContent": v,
                    }),
                    Err(ToolError(e)) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                }
            }
            "resources/list" => json!({ "resources": [] }),
            "prompts/list" => json!({ "prompts": [] }),
            _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn url(&self, slug: &str, version: Option<i64>, path: &str) -> String {
        format!(
            "{}{}{}",
            self.state.config.base_url,
            doc_base(slug, version),
            paths::url_suffix(path)
        )
    }

    async fn doc(&self, slug: &str) -> Result<db::DocumentSummary, ToolError> {
        db::get_document(&self.state.db, slug)
            .await?
            .ok_or_else(|| ToolError(format!("no document {slug:?}; call list_documents to see what exists")))
    }

    async fn version(&self, doc: &db::DocumentSummary, number: Option<i64>) -> Result<db::Version, ToolError> {
        db::version(&self.state.db, doc.id, number).await?.ok_or_else(|| {
            ToolError(format!(
                "document {:?} has no version {}",
                doc.slug,
                number.unwrap_or(0)
            ))
        })
    }

    async fn list_documents(&self) -> ToolResult {
        let docs = db::list_documents(&self.state.db).await?;
        Ok(json!({
            "documents": docs.iter().map(|d| json!({
                "slug": d.slug,
                "title": d.title,
                "url": self.url(&d.slug, None, "index").trim_end_matches('/').to_string() + "/",
                "latest_version": d.latest_version,
                "pages": d.page_count,
                "owner": d.owner,
                "updated_at": d.updated_at,
            })).collect::<Vec<_>>()
        }))
    }

    async fn get_document(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            version: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let version = self.version(&doc, a.version).await?;
        let pages = db::pages(&self.state.db, version.id).await?;
        let versions = db::versions(&self.state.db, doc.id).await?;
        Ok(json!({
            "slug": doc.slug,
            "title": doc.title,
            "owner": doc.owner,
            "url": self.url(&doc.slug, None, "index"),
            "version": version,
            "latest_version": doc.latest_version,
            "pages": pages.iter().map(|p| json!({
                "path": p.path,
                "title": p.title,
                "format": p.format,
                "url": self.url(&doc.slug, a.version, &p.path),
            })).collect::<Vec<_>>(),
            "versions": versions.iter().take(50).collect::<Vec<_>>(),
        }))
    }

    async fn read_page(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            path: String,
            version: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let version = self.version(&doc, a.version).await?;
        let path = paths::normalize(&a.path)?;
        let mut page = None;
        for candidate in [path.clone(), format!("{path}/index")] {
            if let Some(p) = db::page(&self.state.db, version.id, &candidate).await? {
                page = Some(p);
                break;
            }
        }
        let page = page.ok_or_else(|| ToolError(format!("version {} has no page {path:?}", version.number)))?;
        Ok(json!({
            "path": page.path,
            "title": page.title,
            "format": page.format,
            "version": version.number,
            "url": self.url(&doc.slug, Some(version.number), &page.path),
            "content": page.source,
        }))
    }

    async fn publish(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct PageArg {
            path: String,
            content: String,
            format: Option<String>,
            title: Option<String>,
        }
        #[derive(Deserialize)]
        struct A {
            slug: Option<String>,
            title: Option<String>,
            message: Option<String>,
            #[serde(default)]
            pages: Vec<PageArg>,
            mode: Option<String>,
            #[serde(default)]
            delete_paths: Vec<String>,
        }
        let a: A = args(a)?;
        let merge = match a.mode.as_deref().unwrap_or("replace") {
            "replace" => false,
            "merge" => true,
            m => return Err(ToolError(format!("mode must be \"replace\" or \"merge\", not {m:?}"))),
        };
        if a.pages.is_empty() && a.delete_paths.is_empty() {
            return Err(ToolError("pass at least one page".into()));
        }
        if a.pages.len() > MAX_PAGES {
            return Err(ToolError(format!("at most {MAX_PAGES} pages per document")));
        }

        let mut pages = Vec::new();
        let mut warnings = Vec::new();
        let empty = HashMap::new();
        for (i, p) in a.pages.into_iter().enumerate() {
            let path = paths::normalize(&p.path)?;
            if pages.iter().any(|np: &db::NewPage| np.path == path) {
                return Err(ToolError(format!("page {path:?} is listed twice")));
            }
            if p.content.len() > MAX_PAGE_BYTES {
                return Err(ToolError(format!(
                    "page {path:?} is larger than {MAX_PAGE_BYTES} bytes"
                )));
            }
            let format = match p.format.as_deref() {
                Some(f) => {
                    Format::parse(f).ok_or_else(|| ToolError(format!("page {path:?}: format must be md or mdx")))?
                }
                None if p.path.trim().ends_with(".mdx") => Format::Mdx,
                None if p.path.trim().ends_with(".md") => Format::Md,
                None if looks_like_mdx(&p.content) => Format::Mdx,
                None => Format::Md,
            };
            let tree = render::parse(&p.content, format)
                .map_err(|e| ToolError(format!("page {path:?} is not valid {}: {e}", format.as_str())))?;
            let meta = render::meta(&tree);
            let opts = Options {
                page_path: &path,
                base_url: "/",
                answers: &empty,
            };
            for w in render::render_tree(&tree, &opts).warnings {
                warnings.push(json!({ "page": path, "warning": w }));
            }
            let title = p.title.or(meta.title).unwrap_or_else(|| paths::title_from_path(&path));
            pages.push(db::NewPage {
                position: meta.order.unwrap_or(i as i64),
                title: title.chars().take(200).collect(),
                path,
                format: format.as_str(),
                source: p.content,
            });
        }

        let exists = match &a.slug {
            Some(s) => db::get_document(&self.state.db, &db::doc_slug(s)).await?.is_some(),
            None => false,
        };
        let title = a.title.clone().or_else(|| {
            if exists {
                return None;
            }
            pages
                .iter()
                .find(|p| p.path == "index")
                .or(pages.first())
                .map(|p| p.title.clone())
        });
        let (slug, number) = db::publish(
            &self.state.db,
            db::Publish {
                user_id: self.user.id,
                slug: a.slug.as_deref(),
                title: title.as_deref(),
                message: a.message.as_deref(),
                pages,
                merge,
                delete: a.delete_paths.iter().filter_map(|p| paths::normalize(p).ok()).collect(),
            },
        )
        .await?;
        let doc = self.doc(&slug).await?;
        let version = self.version(&doc, Some(number)).await?;
        let all = db::pages(&self.state.db, version.id).await?;
        Ok(json!({
            "slug": slug,
            "version": number,
            "url": self.url(&slug, None, "index"),
            "version_url": self.url(&slug, Some(number), "index"),
            "pages": all.iter().map(|p| json!({ "path": p.path, "title": p.title, "url": self.url(&slug, None, &p.path) })).collect::<Vec<_>>(),
            "warnings": warnings,
        }))
    }

    async fn get_feedback(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            version: Option<i64>,
            since: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let cursor = db::now();
        let (responses, selections) = db::feedback(&self.state.db, doc.id, a.version, a.since.unwrap_or(0)).await?;

        // Field labels, so answers make sense without re-reading the page.
        let mut labels: HashMap<(i64, String), HashMap<String, String>> = HashMap::new();
        for r in &responses {
            let key = (r.version, r.page.clone());
            if labels.contains_key(&key) {
                continue;
            }
            let mut map = HashMap::new();
            if let Some(v) = db::version(&self.state.db, doc.id, Some(r.version)).await?
                && let Some(p) = db::page(&self.state.db, v.id, &r.page).await?
            {
                let empty = HashMap::new();
                let opts = Options {
                    page_path: &p.path,
                    base_url: "/",
                    answers: &empty,
                };
                if let Ok(rendered) = render::render(&p.source, Format::parse(&p.format).unwrap_or(Format::Md), &opts) {
                    map = rendered.fields.into_iter().map(|f| (f.name, f.label)).collect();
                }
            }
            labels.insert(key, map);
        }

        Ok(json!({
            "document": doc.slug,
            "latest_version": doc.latest_version,
            "cursor": cursor,
            "responses": responses.iter().map(|r| json!({
                "version": r.version,
                "page": r.page,
                "field": r.field,
                "label": labels.get(&(r.version, r.page.clone())).and_then(|m| m.get(&r.field)),
                "value": r.value(),
                "user": r.user,
                "updated_at": r.updated_at,
            })).collect::<Vec<_>>(),
            "selections": selections.iter().map(|s| json!({
                "id": s.id,
                "version": s.version,
                "page": s.page,
                "quote": s.quote,
                "comment": s.comment,
                "context_before": s.prefix,
                "context_after": s.suffix,
                "user": s.user,
                "created_at": s.created_at,
            })).collect::<Vec<_>>(),
            "hint": "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
        }))
    }
}

/// Content that uses one of our components (or any capitalised JSX tag).
fn looks_like_mdx(content: &str) -> bool {
    content
        .match_indices('<')
        .any(|(i, _)| content[i + 1..].chars().next().is_some_and(|c| c.is_ascii_uppercase()))
}

fn tool_definitions() -> Value {
    let slug =
        json!({ "type": "string", "description": "Document slug, as returned by publish_document or list_documents." });
    let version = json!({ "type": "integer", "description": "Version number. Defaults to the latest." });
    json!([
        {
            "name": "list_documents",
            "title": "List documents",
            "description": "List all documents with their latest version and URL.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "get_document",
            "title": "Get document",
            "description": "Get a document's pages (paths, titles, URLs) and its version history.",
            "inputSchema": { "type": "object", "properties": { "slug": slug, "version": version }, "required": ["slug"] },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "read_page",
            "title": "Read page",
            "description": "Read the Markdown/MDX source of one page.",
            "inputSchema": {
                "type": "object",
                "properties": { "slug": slug, "path": { "type": "string", "description": "Page path, e.g. \"index\" or \"plan/phase-1\"." }, "version": version },
                "required": ["slug", "path"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "publish_document",
            "title": "Publish document",
            "description": "Create a document, or publish a new version of an existing one. Each call creates a new version. \
    Pages are CommonMark/GFM Markdown (\"md\") or MDX (\"mdx\", which can use the components from list_components). \
    Paths may be nested (\"plan/phase-1\"); \"index\" is the landing page and \"plan/index\" the page for the \"plan\" folder. \
    Pages are listed in the order given, unless their YAML frontmatter has `order: <n>`; the title comes from `title`, the frontmatter, or the first # heading. \
    Relative links between pages (\"phase-2.md\", \"../index.md\") work like links between files. \
    Returns the URL to give to the reader, plus any rendering warnings.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "Existing document to update, or the slug for a new one. Omit to create a new document with a slug derived from the title." },
                    "title": { "type": "string", "description": "Document title. Defaults to the title of the index (or first) page for new documents." },
                    "message": { "type": "string", "description": "What changed in this version." },
                    "pages": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Page path, e.g. \"index\", \"plan/phase-1\" or \"notes.md\"." },
                                "content": { "type": "string", "description": "Markdown or MDX source." },
                                "format": { "type": "string", "enum": ["md", "mdx"], "description": "Defaults to the path's extension, else mdx if the content uses <Components>, else md." },
                                "title": { "type": "string", "description": "Page title for the menu." },
                            },
                            "required": ["path", "content"],
                        },
                    },
                    "mode": { "type": "string", "enum": ["replace", "merge"], "description": "replace (default): the new version has exactly these pages. merge: keep the previous version's other pages." },
                    "delete_paths": { "type": "array", "items": { "type": "string" }, "description": "With mode merge, pages to drop from the previous version." },
                },
                "required": ["pages"],
            },
        },
        {
            "name": "get_feedback",
            "title": "Get feedback",
            "description": "Read what people answered in a document's form fields and the text they selected and commented on. \
    Use `cursor` from the result as `since` to poll for new feedback.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": slug,
                    "version": { "type": "integer", "description": "Only feedback on this version. Defaults to all versions." },
                    "since": { "type": "integer", "description": "Unix time; only feedback at or after it." },
                },
                "required": ["slug"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "list_components",
            "title": "List MDX components",
            "description": "Reference for the MDX components (form fields, callouts…) pages can use.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
    ])
}
