//! Browser sign-in: GitHub OAuth, plus an optional development login.

use axum::Form;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use maud::{Markup, html};
use serde::Deserialize;

use crate::AppState;
use crate::db::{self, User};
use crate::error::{AppError, AppResult};
use crate::web::layout;

pub const SESSION_COOKIE: &str = "docs_session";
const STATE_COOKIE: &str = "docs_oauth_state";

/// Who is looking at the page. Never fails; use [`Viewer::require`] to insist on a user.
pub struct Viewer {
    pub user: Option<User>,
    pub csrf: String,
    path: String,
}

impl FromRequestParts<AppState> for Viewer {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".into());
        let session = match jar.get(SESSION_COOKIE) {
            Some(c) => db::session_user(&state.db, c.value()).await?,
            None => None,
        };
        // Re-check the allowlist on every request, so removing someone from
        // DOCS_ALLOWED_USERS ends their existing sessions too.
        let session = session.filter(|(user, _)| state.config.user_allowed(&user.login));
        Ok(match session {
            Some((user, csrf)) => Viewer {
                user: Some(user),
                csrf,
                path,
            },
            None => Viewer {
                user: None,
                csrf: String::new(),
                path,
            },
        })
    }
}

impl Viewer {
    pub fn require(&self) -> AppResult<&User> {
        self.user.as_ref().ok_or_else(|| AppError::Login(self.path.clone()))
    }

    pub fn check_csrf(&self, token: &str) -> AppResult<()> {
        if self.user.is_some() && !token.is_empty() && constant_time_eq(token.as_bytes(), self.csrf.as_bytes()) {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "Your session expired; reload the page and try again.".into(),
            ))
        }
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Only allow redirects to paths on this site.
pub fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(n) if n.starts_with('/') && !n.starts_with("//") && !n.starts_with("/\\") => n.to_string(),
        _ => "/".into(),
    }
}

fn session_cookie(state: &AppState, value: String) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .path("/")
        .http_only(true)
        .secure(state.config.secure_cookies())
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(db::SESSION_TTL))
        .build()
}

async fn sign_in(state: &AppState, jar: CookieJar, user: &User, next: &str) -> AppResult<Response> {
    if !state.config.user_allowed(&user.login) {
        return Err(AppError::Forbidden(format!(
            "{} is not allowed to use this site.",
            user.login
        )));
    }
    let token = db::create_session(&state.db, user.id).await?;
    Ok((jar.add(session_cookie(state, token)), Redirect::to(next)).into_response())
}

#[derive(Deserialize)]
pub struct NextQuery {
    next: Option<String>,
}

pub async fn login_page(State(state): State<AppState>, viewer: Viewer, Query(q): Query<NextQuery>) -> Markup {
    let next = safe_next(q.next.as_deref());
    let enc_next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
    layout::simple(
        "Sign in",
        viewer.user.as_ref(),
        &viewer.csrf,
        html! {
            div.card.narrow {
                h1 { "Sign in" }
                p { "Sign in to read documents and leave feedback for the agents that wrote them." }
                @if state.config.github.is_some() {
                    a.button.primary href={ "/auth/github?next=" (enc_next) } { "Sign in with GitHub" }
                }
                @if state.config.dev_login {
                    form.dev-login method="post" action="/auth/dev" {
                        input type="hidden" name="next" value=(next);
                        label for="login" { "Development login" }
                        div.row {
                            input #login type="text" name="login" placeholder="username" required pattern="[A-Za-z0-9_.-]+";
                            button type="submit" { "Sign in" }
                        }
                    }
                }
                @if state.config.github.is_none() && !state.config.dev_login {
                    p.notice { "No sign-in method is configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." }
                }
            }
        },
    )
}

#[derive(Deserialize)]
pub struct DevLogin {
    login: String,
    next: Option<String>,
}

pub async fn dev_login(State(state): State<AppState>, jar: CookieJar, Form(f): Form<DevLogin>) -> AppResult<Response> {
    if !state.config.dev_login {
        return Err(AppError::NotFound);
    }
    let login = f.login.trim();
    if login.is_empty() || !login.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        return Err(AppError::BadRequest(
            "Pick a username made of letters, digits, '.', '_' or '-'.".into(),
        ));
    }
    let user = db::upsert_user(&state.db, "dev", login, login, None, None).await?;
    sign_in(&state, jar, &user, &safe_next(f.next.as_deref())).await
}

#[derive(Deserialize)]
pub struct LogoutForm {
    csrf: String,
}

pub async fn logout(
    State(state): State<AppState>,
    viewer: Viewer,
    jar: CookieJar,
    Form(f): Form<LogoutForm>,
) -> AppResult<Response> {
    viewer.check_csrf(&f.csrf)?;
    if let Some(c) = jar.get(SESSION_COOKIE) {
        db::delete_session(&state.db, c.value()).await?;
    }
    Ok((
        jar.remove(Cookie::build(SESSION_COOKIE).path("/")),
        Redirect::to("/login"),
    )
        .into_response())
}

pub async fn github_start(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<NextQuery>,
) -> AppResult<Response> {
    let gh = state.config.github.as_ref().ok_or(AppError::NotFound)?;
    let csrf_state = db::random_token();
    let next = safe_next(q.next.as_deref());
    let enc_next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
    let cookie = Cookie::build((STATE_COOKIE, format!("{csrf_state}|{enc_next}")))
        .path("/auth/github")
        .http_only(true)
        .secure(state.config.secure_cookies())
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10))
        .build();
    let url = url::Url::parse_with_params(
        "https://github.com/login/oauth/authorize",
        &[
            ("client_id", gh.client_id.as_str()),
            (
                "redirect_uri",
                &format!("{}/auth/github/callback", state.config.base_url),
            ),
            ("scope", "read:user"),
            ("state", &csrf_state),
            ("allow_signup", "false"),
        ],
    )?;
    Ok((jar.add(cookie), Redirect::to(url.as_str())).into_response())
}

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error_description: Option<String>,
}

pub async fn github_callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(cb): Query<Callback>,
) -> AppResult<Response> {
    let gh = state.config.github.as_ref().ok_or(AppError::NotFound)?;
    if let Some(e) = cb.error_description {
        return Err(AppError::BadRequest(format!("GitHub sign-in failed: {e}")));
    }
    let saved = jar.get(STATE_COOKIE).map(|c| c.value().to_string()).unwrap_or_default();
    let (saved_state, enc_next) = saved.split_once('|').unwrap_or(("", ""));
    let next: String = url::form_urlencoded::parse(format!("n={enc_next}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let (Some(code), Some(got_state)) = (cb.code, cb.state) else {
        return Err(AppError::BadRequest("GitHub did not return a code.".into()));
    };
    if saved_state.is_empty() || !constant_time_eq(saved_state.as_bytes(), got_state.as_bytes()) {
        return Err(AppError::BadRequest(
            "Sign-in expired or was started in another browser; try again.".into(),
        ));
    }
    let next = safe_next(Some(&next));

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: Option<String>,
        error_description: Option<String>,
    }
    let token: TokenResponse = state
        .http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", gh.client_id.as_str()),
            ("client_secret", gh.client_secret.as_str()),
            ("code", code.as_str()),
            (
                "redirect_uri",
                &format!("{}/auth/github/callback", state.config.base_url),
            ),
        ])
        .send()
        .await?
        .json()
        .await?;
    let Some(access_token) = token.access_token else {
        return Err(AppError::BadRequest(format!(
            "GitHub sign-in failed: {}",
            token.error_description.unwrap_or_else(|| "no access token".into())
        )));
    };

    #[derive(Deserialize)]
    struct GhUser {
        id: i64,
        login: String,
        name: Option<String>,
        avatar_url: Option<String>,
    }
    let gh_user: GhUser = state
        .http
        .get("https://api.github.com/user")
        .bearer_auth(&access_token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let user = db::upsert_user(
        &state.db,
        "github",
        &gh_user.id.to_string(),
        &gh_user.login,
        gh_user.name.as_deref(),
        gh_user.avatar_url.as_deref(),
    )
    .await?;
    let jar = jar.remove(Cookie::build(STATE_COOKIE).path("/auth/github"));
    sign_in(&state, jar, &user, &next).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_must_be_local() {
        assert_eq!(safe_next(Some("/d/x/")), "/d/x/");
        assert_eq!(safe_next(Some("//evil.com")), "/");
        assert_eq!(safe_next(Some("/\\evil.com")), "/");
        assert_eq!(safe_next(Some("https://evil.com")), "/");
        assert_eq!(safe_next(None), "/");
    }
}
