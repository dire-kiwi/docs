//! Organizations: creating them, and their members.

use axum::Form;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Redirect, Response};
use maud::{Markup, html};
use serde::Deserialize;

use crate::AppState;
use crate::db::{self, Organization, User};
use crate::error::{AppError, AppResult};
use crate::web::auth::Viewer;
use crate::web::layout::{self, time};

const MAX_NAME_CHARS: usize = 100;

/// `GET /orgs`: your organizations, and a form to create one.
pub async fn list(State(state): State<AppState>, viewer: Viewer) -> AppResult<Markup> {
    render_list(&state, &viewer, None).await
}

async fn render_list(state: &AppState, viewer: &Viewer, error: Option<String>) -> AppResult<Markup> {
    let user = viewer.require()?;
    let orgs = db::user_organizations(&state.db, user).await?;
    Ok(layout::simple(
        "Organizations",
        Some(user),
        &viewer.csrf,
        html! {
            h1 { "Organizations" }
            p { "An organization's documents belong to all its members: each of them, and their agents, can read them, "
                "publish new versions, and label, move and share them. Agents publish to one with "
                code { "publish_document" } "'s " code { "organization" } "." }
            @if let Some(e) = &error { div.render-error { (e) } }
            @if orgs.is_empty() {
                p.muted { "You aren't in any organizations yet." }
            } @else {
                div.table-wrap { table {
                    thead { tr { th { "Name" } th { "Slug" } th { "Your role" } th { "Documents" } } }
                    tbody {
                        @for o in &orgs {
                            tr {
                                td { a href={ "/orgs/" (o.slug) } { (o.name) } }
                                td { code { (o.slug) } }
                                td { (o.role) }
                                td { a href={ "/#org-" (o.slug) } { (o.documents) } }
                            }
                        }
                    }
                } }
            }
            h2 { "Create an organization" }
            form.stack method="post" action="/orgs" {
                input type="hidden" name="csrf" value=(viewer.csrf);
                label { "Name" input type="text" name="name" required maxlength=(MAX_NAME_CHARS) placeholder="Acme"; }
                label { "Slug " span.muted.small { "(optional: used in URLs and by agents; made from the name if empty)" }
                    input type="text" name="slug" maxlength="60" placeholder="acme"; }
                button.primary type="submit" { "Create" }
            }
        },
    ))
}

#[derive(Deserialize)]
pub struct CreateForm {
    csrf: String,
    name: String,
    #[serde(default)]
    slug: String,
}

/// `POST /orgs`: create an organization, with you as its owner.
pub async fn create(State(state): State<AppState>, viewer: Viewer, Form(f): Form<CreateForm>) -> AppResult<Response> {
    viewer.check_csrf(&f.csrf)?;
    let user = viewer.require()?;
    let name = f.name.trim();
    let created = if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        Err(format!(
            "give the organization a name of up to {MAX_NAME_CHARS} characters"
        ))
    } else {
        let slug = if f.slug.trim().is_empty() {
            db::doc_slug(name)
        } else {
            f.slug.clone()
        };
        match db::normalize_org_slug(&slug) {
            Ok(slug) => db::create_organization(&state.db, &slug, name, user).await?,
            Err(e) => Err(e),
        }
    };
    match created {
        Ok(o) => Ok(Redirect::to(&format!("/orgs/{}", o.slug)).into_response()),
        Err(e) => Ok(render_list(&state, &viewer, Some(e)).await?.into_response()),
    }
}

async fn member_org(state: &AppState, slug: &str, user: &User) -> AppResult<Organization> {
    // Organizations you aren't in are reported as missing.
    db::organization(&state.db, slug, user).await?.ok_or(AppError::NotFound)
}

/// `GET /orgs/{slug}`: an organization's members; its owners manage them here.
pub async fn show(State(state): State<AppState>, viewer: Viewer, Path(slug): Path<String>) -> AppResult<Markup> {
    let user = viewer.require()?;
    let org = member_org(&state, &slug, user).await?;
    render_org(&state, &viewer, user, &org, None).await
}

async fn render_org(
    state: &AppState,
    viewer: &Viewer,
    user: &User,
    org: &Organization,
    error: Option<String>,
) -> AppResult<Markup> {
    let members = db::org_members(&state.db, org.id).await?;
    let me = user.login.to_lowercase();
    let action = format!("/orgs/{}/members", org.slug);
    let form = |act: &str, login: &str, label: &str, class: &str| {
        html! {
            form.inline method="post" action=(action) {
                input type="hidden" name="csrf" value=(viewer.csrf);
                input type="hidden" name="action" value=(act);
                input type="hidden" name="login" value=(login);
                button class=(class) type="submit" { (label) }
            }
        }
    };
    Ok(layout::simple(
        &org.name,
        Some(user),
        &viewer.csrf,
        html! {
            p.crumbs { a href="/orgs" { "Organizations" } " / " (org.slug) }
            h1 { (org.name) }
            p {
                a href={ "/#org-" (org.slug) } { (org.documents) " " (if org.documents == 1 { "document" } else { "documents" }) }
                ". Agents publish here with " code { "publish_document" } "'s " code { "organization: \"" (org.slug) "\"" } "."
            }
            @if let Some(e) = &error { div.render-error { (e) } }
            h2 { "Members" }
            p.muted { "Every member can read, publish, label, move and share the organization's documents. "
                "Owners also add and remove members." }
            ul.share-list {
                @for m in &members {
                    li {
                        strong { (m.login) } " " span.badge { (m.role) }
                        " " span.muted.small { "added " (time(m.created_at)) }
                        @if m.login == me {
                            " " (form("remove", &m.login, "Leave", "link danger"))
                        } @else if org.is_owner() {
                            @if m.role == "owner" {
                                " " (form("member", &m.login, "Make member", "link"))
                            } @else {
                                " " (form("owner", &m.login, "Make owner", "link"))
                            }
                            " " (form("remove", &m.login, "Remove", "link danger"))
                        }
                    }
                }
            }
            @if org.is_owner() {
                form.row method="post" action=(action) {
                    input type="hidden" name="csrf" value=(viewer.csrf);
                    input type="text" name="login" placeholder="GitHub username" required maxlength="100" aria-label="Username";
                    select name="action" aria-label="Role" {
                        option value="member" selected { "Member" }
                        option value="owner" { "Owner" }
                    }
                    button type="submit" { "Add" }
                }
                p.muted.small { "People can be added before they first sign in." }
                h2 { "Delete" }
                @if org.documents > 0 {
                    p.muted { "Move or delete its documents first." }
                } @else {
                    form method="post" action={ "/orgs/" (org.slug) "/delete" } {
                        input type="hidden" name="csrf" value=(viewer.csrf);
                        button.danger type="submit" { "Delete " (org.name) }
                    }
                }
            }
        },
    ))
}

#[derive(Deserialize)]
pub struct MemberForm {
    csrf: String,
    /// `member` or `owner` (add someone, or change their role), or `remove`.
    action: String,
    #[serde(default)]
    login: String,
}

/// `POST /orgs/{slug}/members`: owners add members, change roles and remove members;
/// anyone can remove themselves (leave).
pub async fn update_members(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(slug): Path<String>,
    Form(f): Form<MemberForm>,
) -> AppResult<Response> {
    viewer.check_csrf(&f.csrf)?;
    let user = viewer.require()?;
    let org = member_org(&state, &slug, user).await?;
    let Some(login) = db::normalize_login(&f.login) else {
        let e = format!("{:?} is not a valid username.", f.login);
        return Ok(render_org(&state, &viewer, user, &org, Some(e)).await?.into_response());
    };
    let leaving = f.action == "remove" && login == user.login.to_lowercase();
    if !org.is_owner() && !leaving {
        return Err(AppError::Forbidden(
            "Only the organization's owners can change its members.".into(),
        ));
    }
    let done = match f.action.as_str() {
        role if db::ORG_ROLES.contains(&role) => db::set_member(&state.db, org.id, &login, role).await?,
        "remove" => db::remove_member(&state.db, org.id, &login).await?,
        _ => return Err(AppError::BadRequest("unknown action".into())),
    };
    match done {
        Ok(()) if leaving => Ok(Redirect::to("/orgs").into_response()),
        Ok(()) => Ok(Redirect::to(&format!("/orgs/{}", org.slug)).into_response()),
        Err(e) => Ok(render_org(&state, &viewer, user, &org, Some(e)).await?.into_response()),
    }
}

#[derive(Deserialize)]
pub struct CsrfForm {
    csrf: String,
}

/// `POST /orgs/{slug}/delete`: delete an organization with no documents (owners only).
pub async fn delete(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(slug): Path<String>,
    Form(f): Form<CsrfForm>,
) -> AppResult<Response> {
    viewer.check_csrf(&f.csrf)?;
    let user = viewer.require()?;
    let org = member_org(&state, &slug, user).await?;
    if !org.is_owner() {
        return Err(AppError::Forbidden(
            "Only the organization's owners can delete it.".into(),
        ));
    }
    match db::delete_organization(&state.db, org.id).await? {
        Ok(()) => Ok(Redirect::to("/orgs").into_response()),
        Err(e) => Ok(render_org(&state, &viewer, user, &org, Some(e)).await?.into_response()),
    }
}
