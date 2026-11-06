//! Server-rendered HTML pages.

use std::collections::HashMap;

use axum::Form;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Redirect, Response};
use maud::{Markup, PreEscaped, html};
use serde::Deserialize;

use crate::AppState;
use crate::components::COMPONENTS;
use crate::db::{self, DocumentSummary, Version};
use crate::error::{AppError, AppResult};
use crate::paths::{self, NavNode};
use crate::render::{self, Format, Options};
use crate::web::auth::Viewer;
use crate::web::layout::{self, Shell, shell, time};

pub fn doc_base(slug: &str, version: Option<i64>) -> String {
    match version {
        Some(n) => format!("/d/{slug}/-/v/{n}/"),
        None => format!("/d/{slug}/"),
    }
}

fn mcp_help(base: &str) -> Markup {
    html! {
        p { "Agents publish here through the MCP server at " code { (base) "/mcp" } ". For example, with Claude Code:" }
        pre { code { "claude mcp add --transport http docs " (base) "/mcp" } }
        p { "The client signs in with OAuth in your browser. Agents without OAuth support can use a "
            a href="/settings/tokens" { "personal access token" } " instead." }
    }
}

pub async fn home(State(state): State<AppState>, viewer: Viewer) -> AppResult<Markup> {
    let user = viewer.require()?;
    let docs = db::list_documents(&state.db).await?;
    Ok(layout::simple(
        "Documents",
        Some(user),
        &viewer.csrf,
        html! {
            h1 { "Documents" }
            @if docs.is_empty() {
                div.card {
                    p { strong { "Nothing here yet." } }
                    (mcp_help(&state.config.base_url))
                }
            } @else {
                div.table-wrap {
                    table.doc-list {
                        thead { tr { th { "Title" } th { "Pages" } th { "Version" } th { "Owner" } th { "Updated" } } }
                        tbody {
                            @for d in &docs {
                                tr {
                                    td { a href=(doc_base(&d.slug, None)) { (d.title) } br; small.muted { (d.slug) } }
                                    td { (d.page_count) }
                                    td { a href={ "/d/" (d.slug) "/-/versions" } { "v" (d.latest_version) } }
                                    td { (d.owner) }
                                    td { (time(d.updated_at)) }
                                }
                            }
                        }
                    }
                }
                details.connect {
                    summary { "Connect an agent" }
                    (mcp_help(&state.config.base_url))
                }
            }
        },
    ))
}

pub async fn components_page(viewer: Viewer) -> Markup {
    let answers = HashMap::new();
    let opts = Options {
        page_path: "index",
        base_url: "/",
        answers: &answers,
    };
    layout::simple(
        "Components",
        viewer.user.as_ref(),
        &viewer.csrf,
        html! {
            h1 { "MDX components" }
            p.lead {
                "Pages published as " code { "mdx" } " can use these components. Form fields save answers as the reader types; "
                "agents read them back with the " code { "get_feedback" } " MCP tool, together with any text readers "
                "selected and commented on. There is no " code { "import" } " and " code { "{expressions}" }
                " are not evaluated; attribute values can be strings or JSON-like literals."
            }
            nav.component-index {
                @for c in COMPONENTS { a href={ "#" (c.name) } { (c.name) } }
            }
            @for c in COMPONENTS {
                section.component id=(c.name) {
                    h2 { code { "<" (c.name) ">" } }
                    p { (c.summary) }
                    table.props {
                        tbody {
                            @for prop in c.props { tr { th { code { (prop.name) } } td { (prop.doc) } } }
                            @if let Some(a) = c.answer { tr { th { "answer" } td { code { (a) } } } }
                        }
                    }
                    div.example {
                        pre { code.language-mdx { (c.example) } }
                        div.preview.doc-content {
                            @match render::render(c.example, Format::Mdx, &opts) {
                                Ok(r) => (PreEscaped(r.html)),
                                Err(e) => p.render-error { (e) },
                            }
                        }
                    }
                }
            }
        },
    )
}

// ---------- documents ----------

async fn load_doc(state: &AppState, slug: &str, number: Option<i64>) -> AppResult<(DocumentSummary, Version)> {
    let doc = db::get_document(&state.db, slug).await?.ok_or(AppError::NotFound)?;
    let version = db::version(&state.db, doc.id, number)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok((doc, version))
}

pub async fn doc_redirect(Path(slug): Path<String>) -> Redirect {
    Redirect::permanent(&doc_base(&slug, None))
}

pub async fn doc_root(state: State<AppState>, viewer: Viewer, Path(slug): Path<String>) -> AppResult<Response> {
    show_page(state, viewer, slug, None, String::new()).await
}

pub async fn doc_page(
    state: State<AppState>,
    viewer: Viewer,
    Path((slug, path)): Path<(String, String)>,
) -> AppResult<Response> {
    show_page(state, viewer, slug, None, path).await
}

pub async fn version_root(
    state: State<AppState>,
    viewer: Viewer,
    Path((slug, n)): Path<(String, i64)>,
) -> AppResult<Response> {
    show_page(state, viewer, slug, Some(n), String::new()).await
}

pub async fn version_page(
    state: State<AppState>,
    viewer: Viewer,
    Path((slug, n, path)): Path<(String, i64, String)>,
) -> AppResult<Response> {
    show_page(state, viewer, slug, Some(n), path).await
}

async fn show_page(
    State(state): State<AppState>,
    viewer: Viewer,
    slug: String,
    number: Option<i64>,
    suffix: String,
) -> AppResult<Response> {
    let user = viewer.require()?;
    let (doc, version) = load_doc(&state, &slug, number).await?;
    let base = doc_base(&doc.slug, number);
    let pages = db::pages(&state.db, version.id).await?;

    let mut page = None;
    for candidate in paths::candidates(&suffix) {
        if let Some(p) = db::page(&state.db, version.id, &candidate).await? {
            page = Some(p);
            break;
        }
    }
    let Some(page) = page else {
        // A document without an index page opens on its first page.
        if suffix.is_empty()
            && let Some(first) = pages.first()
        {
            return Ok(Redirect::to(&format!("{base}{}", paths::url_suffix(&first.path))).into_response());
        }
        return Err(AppError::NotFound);
    };
    let canonical = paths::url_suffix(&page.path);
    if canonical != suffix {
        return Ok(Redirect::to(&format!("{base}{canonical}")).into_response());
    }

    let answers = db::user_answers(&state.db, version.id, &page.path, user.id).await?;
    let format = Format::parse(&page.format).unwrap_or(Format::Md);
    let opts = Options {
        page_path: &page.path,
        base_url: &base,
        answers: &answers,
    };
    let rendered = render::render(&page.source, format, &opts);
    let selections = db::page_selections(&state.db, version.id, &page.path).await?;
    let nav = paths::nav_tree(
        &pages
            .iter()
            .map(|p| (p.path.clone(), p.title.clone()))
            .collect::<Vec<_>>(),
    );
    let is_latest = number.is_none() || number == Some(doc.latest_version);
    let title = format!("{} · {}", page.title, doc.title);

    let body = html! {
        div.doc-layout {
            nav.doc-nav #doc-nav aria-label="Pages" {
                a.doc-title href=(base) { (doc.title) }
                a.version-link href={ "/d/" (doc.slug) "/-/versions" } {
                    "Version " (version.number)
                    @if is_latest { " (latest)" }
                }
                (nav_list(&nav, &base, &page.path))
                div.doc-links {
                    a href={ "/d/" (doc.slug) "/-/feedback" } { "All feedback" }
                }
            }
            main.doc-main {
                @if !is_latest {
                    div.banner {
                        "You are viewing version " (version.number) ". "
                        a href={ (doc_base(&doc.slug, None)) (canonical) } { "Go to the latest version (v" (doc.latest_version) ")" }
                    }
                }
                @match &rendered {
                    Ok(r) => {
                        @for w in &r.warnings { div.render-warning { "⚠ " (w) } }
                        article.doc-content data-version-id=(version.id) data-page=(page.path) {
                            @if !r.has_h1 { h1 { (page.title) } }
                            (PreEscaped(&r.html))
                        }
                    }
                    Err(e) => {
                        div.render-error { "This page could not be rendered: " (e) }
                        pre { code { (page.source) } }
                    }
                }
                section.selections #selections data-version-id=(version.id) data-page=(page.path) {
                    h2 { "Comments on this page" }
                    p.muted.hint { "Select any text above to quote it and leave a comment for the agent." }
                    ol.selection-list {
                        @for s in &selections {
                            li.selection data-id=(s.id) data-quote=(s.quote) data-prefix=(s.prefix) data-suffix=(s.suffix) {
                                blockquote { (s.quote) }
                                @if !s.comment.is_empty() { p { (s.comment) } }
                                footer {
                                    span { (s.user) " · " (time(s.created_at)) }
                                    @if s.user_id == user.id {
                                        button.link.delete-selection type="button" { "Delete" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            aside.doc-aside {
                @if let Ok(r) = &rendered {
                    @if !r.toc.is_empty() {
                        nav.toc aria-label="On this page" {
                            h2 { "On this page" }
                            ul {
                                @for t in &r.toc {
                                    li class={ "toc-" (t.depth) } { a href={ "#" (t.id) } { (t.text) } }
                                }
                            }
                        }
                    }
                }
                p.muted.small { "Published by " (version.author) " " (time(version.created_at))
                    @if let Some(m) = &version.message { br; "“" (m) "”" } }
            }
        }
    };
    Ok(shell(
        Shell {
            title: &title,
            user: Some(user),
            csrf: &viewer.csrf,
            body_class: "doc",
        },
        body,
    )
    .into_response())
}

fn nav_list(nodes: &[NavNode], base: &str, current: &str) -> Markup {
    html! {
        ul {
            @for n in nodes {
                li {
                    @if let Some(p) = &n.page {
                        a href={ (base) (paths::url_suffix(p)) } aria-current=[(p == current).then_some("page")] { (n.title) }
                    } @else {
                        span.folder { (n.title) }
                    }
                    @if !n.children.is_empty() { (nav_list(&n.children, base, current)) }
                }
            }
        }
    }
}

pub async fn versions_page(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(slug): Path<String>,
) -> AppResult<Markup> {
    let user = viewer.require()?;
    let doc = db::get_document(&state.db, &slug).await?.ok_or(AppError::NotFound)?;
    let versions = db::versions(&state.db, doc.id).await?;
    Ok(layout::simple(
        &format!("Versions · {}", doc.title),
        Some(user),
        &viewer.csrf,
        html! {
            p.crumbs { a href=(doc_base(&doc.slug, None)) { (doc.title) } " / Versions" }
            h1 { "Versions" }
            ol.versions reversed {
                @for v in &versions {
                    li {
                        a href=(doc_base(&doc.slug, Some(v.number))) { "Version " (v.number) }
                        @if v.number == doc.latest_version { " " span.badge { "latest" } }
                        " — " (v.author) ", " (time(v.created_at))
                        @if let Some(m) = &v.message { p.muted { (m) } }
                    }
                }
            }
        },
    ))
}

pub async fn feedback_page(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(slug): Path<String>,
) -> AppResult<Markup> {
    let user = viewer.require()?;
    let doc = db::get_document(&state.db, &slug).await?.ok_or(AppError::NotFound)?;
    let (responses, selections) = db::feedback(&state.db, doc.id, None, 0).await?;
    let link = |version: i64, page: &str| format!("{}{}", doc_base(&doc.slug, Some(version)), paths::url_suffix(page));
    Ok(layout::simple(
        &format!("Feedback · {}", doc.title),
        Some(user),
        &viewer.csrf,
        html! {
            p.crumbs { a href=(doc_base(&doc.slug, None)) { (doc.title) } " / Feedback" }
            h1 { "Feedback" }
            p.muted { "Everything readers have answered or commented. Agents get the same data from the "
                code { "get_feedback" } " MCP tool." }
            h2 { "Answers" }
            @if responses.is_empty() { p.muted { "No answers yet." } } @else {
                div.table-wrap { table {
                    thead { tr { th { "Version" } th { "Page" } th { "Field" } th { "Answer" } th { "By" } th { "When" } } }
                    tbody {
                        @for r in &responses {
                            tr {
                                td { "v" (r.version) }
                                td { a href=(link(r.version, &r.page)) { (r.page) } }
                                td { code { (r.field) } }
                                td { (answer_text(&r.value())) }
                                td { (r.user) }
                                td { (time(r.updated_at)) }
                            }
                        }
                    }
                } }
            }
            h2 { "Comments on selected text" }
            @if selections.is_empty() { p.muted { "No comments yet." } } @else {
                ol.selection-list {
                    @for s in &selections {
                        li.selection {
                            blockquote { (s.quote) }
                            @if !s.comment.is_empty() { p { (s.comment) } }
                            footer { a href=(link(s.version, &s.page)) { (s.page) " (v" (s.version) ")" } " · " (s.user) " · " (time(s.created_at)) }
                        }
                    }
                }
            }
        },
    ))
}

fn answer_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a
            .iter()
            .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
            .collect::<Vec<_>>()
            .join(", "),
        serde_json::Value::Object(o) if o.contains_key("decision") => {
            let d = o.get("decision").and_then(|d| d.as_str()).unwrap_or("");
            match o.get("comment").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
                Some(c) => format!("{d}: {c}"),
                None => d.to_string(),
            }
        }
        other => other.to_string(),
    }
}

// ---------- access tokens ----------

pub async fn tokens_page(State(state): State<AppState>, viewer: Viewer) -> AppResult<Markup> {
    render_tokens(&state, &viewer, None).await
}

async fn render_tokens(state: &AppState, viewer: &Viewer, new_token: Option<String>) -> AppResult<Markup> {
    let user = viewer.require()?;
    let tokens = db::list_tokens(&state.db, user.id).await?;
    let base = &state.config.base_url;
    Ok(layout::simple(
        "Access",
        Some(user),
        &viewer.csrf,
        html! {
            h1 { "Agent access" }
            (mcp_help(base))
            @if let Some(t) = &new_token {
                div.card.new-token {
                    p { strong { "New token — copy it now, it will not be shown again:" } }
                    pre { code { (t) } }
                    p { "Use it as a bearer token, for example:" }
                    pre { code { "claude mcp add --transport http docs " (base) "/mcp --header \"Authorization: Bearer " (t) "\"" } }
                }
            }
            h2 { "Create a personal access token" }
            form.row method="post" action="/settings/tokens" {
                input type="hidden" name="csrf" value=(viewer.csrf);
                input type="text" name="name" placeholder="What is it for?" required maxlength="100";
                button type="submit" { "Create token" }
            }
            h2 { "Active tokens and connected apps" }
            @if tokens.is_empty() { p.muted { "None yet." } } @else {
                div.table-wrap { table {
                    thead { tr { th { "Name" } th { "Type" } th { "Created" } th { "Last used" } th {} } }
                    tbody {
                        @for t in &tokens {
                            tr {
                                td { (t.name.clone().or(t.client_name.clone()).unwrap_or_else(|| "—".into())) }
                                td { @if t.kind == "pat" { "Personal token" } @else { "OAuth app" } }
                                td { (time(t.created_at)) }
                                td { @if let Some(u) = t.last_used_at { (time(u)) } @else { "never" } }
                                td {
                                    form method="post" action={ "/settings/tokens/" (t.id) "/revoke" } {
                                        input type="hidden" name="csrf" value=(viewer.csrf);
                                        button.link.danger type="submit" { "Revoke" }
                                    }
                                }
                            }
                        }
                    }
                } }
            }
        },
    ))
}

#[derive(Deserialize)]
pub struct CreateToken {
    csrf: String,
    name: String,
}

pub async fn create_token(
    State(state): State<AppState>,
    viewer: Viewer,
    Form(f): Form<CreateToken>,
) -> AppResult<Markup> {
    viewer.check_csrf(&f.csrf)?;
    let user = viewer.require()?;
    let name: String = f.name.trim().chars().take(100).collect();
    let token = db::create_token(&state.db, "pat", user.id, None, Some(&name), None).await?;
    render_tokens(&state, &viewer, Some(token)).await
}

#[derive(Deserialize)]
pub struct CsrfForm {
    csrf: String,
}

pub async fn revoke_token(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<i64>,
    Form(f): Form<CsrfForm>,
) -> AppResult<Redirect> {
    viewer.check_csrf(&f.csrf)?;
    let user = viewer.require()?;
    db::revoke_token(&state.db, user.id, id).await?;
    Ok(Redirect::to("/settings/tokens"))
}
