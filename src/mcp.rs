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
use docs_render::publish::{self, PageInput};
use docs_render::tools::{INSTRUCTIONS, tool_definitions};

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

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
                    "share_document" => self.share(arguments).await,
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
        db::get_document(&self.state.db, slug, self.user)
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
        let docs = db::list_documents(&self.state.db, self.user).await?;
        Ok(json!({
            "documents": docs.iter().map(|d| json!({
                "slug": d.slug,
                "title": d.title,
                "url": self.url(&d.slug, None, "index").trim_end_matches('/').to_string() + "/",
                "latest_version": d.latest_version,
                "pages": d.page_count,
                "owner": d.owner,
                "shared_with_you": d.owner_id != self.user.id,
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
        let sharing = if doc.owner_id == self.user.id {
            Some(self.sharing(&doc).await?)
        } else {
            None
        };
        Ok(json!({
            "sharing": sharing,
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
        struct A {
            slug: Option<String>,
            title: Option<String>,
            message: Option<String>,
            #[serde(default)]
            pages: Vec<PageInput>,
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
        let (valid, warnings) = publish::validate_pages(a.pages).map_err(ToolError)?;
        let pages: Vec<db::NewPage> = valid
            .into_iter()
            .map(|p| db::NewPage {
                position: p.position,
                title: p.title,
                path: p.path,
                format: p.format.as_str(),
                source: p.source,
            })
            .collect();

        let exists = match &a.slug {
            Some(s) => db::slug_exists(&self.state.db, &db::doc_slug(s)).await?,
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

    /// Who a document is shared with, and its share link.
    async fn sharing(&self, doc: &db::DocumentSummary) -> Result<Value, ToolError> {
        let shares = db::shares(&self.state.db, doc.id).await?;
        let token = db::share_token(&self.state.db, doc.id).await?;
        Ok(json!({
            "shared_with": shares.iter().map(|s| &s.login).collect::<Vec<_>>(),
            "share_link": token.map(|t| format!("{}/s/{t}", self.state.config.base_url)),
            "manage_url": format!("{}/d/{}/-/share", self.state.config.base_url, doc.slug),
        }))
    }

    async fn share(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            #[serde(default)]
            add_users: Vec<String>,
            #[serde(default)]
            remove_users: Vec<String>,
            link: Option<String>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        if doc.owner_id != self.user.id {
            return Err(ToolError(format!(
                "only the owner ({}) can share {:?}",
                doc.owner, doc.slug
            )));
        }
        let login =
            |l: &String| db::normalize_login(l).ok_or_else(|| ToolError(format!("{l:?} is not a valid username")));
        for l in &a.add_users {
            let l = login(l)?;
            if l != self.user.login.to_lowercase() {
                db::add_share(&self.state.db, doc.id, &l).await?;
            }
        }
        for l in &a.remove_users {
            db::remove_share(&self.state.db, doc.id, &login(l)?).await?;
        }
        match a.link.as_deref() {
            None | Some("keep") => {}
            Some("enable") => {
                if db::share_token(&self.state.db, doc.id).await?.is_none() {
                    db::set_share_token(&self.state.db, doc.id, true).await?;
                }
            }
            Some("regenerate") => {
                db::set_share_token(&self.state.db, doc.id, true).await?;
            }
            Some("disable") => {
                db::set_share_token(&self.state.db, doc.id, false).await?;
            }
            Some(other) => {
                return Err(ToolError(format!(
                    "link must be enable, disable, regenerate or keep, not {other:?}"
                )));
            }
        }
        let mut out = self.sharing(&doc).await?;
        out["url"] = json!(self.url(&doc.slug, None, "index"));
        Ok(out)
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
