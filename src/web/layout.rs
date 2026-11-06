//! Shared page chrome.

use axum::http::StatusCode;
use maud::{DOCTYPE, Markup, html};

use crate::db::User;

pub struct Shell<'a> {
    pub title: &'a str,
    pub user: Option<&'a User>,
    pub csrf: &'a str,
    /// Extra class on `<body>`, e.g. `doc` for the three-column document layout.
    pub body_class: &'a str,
}

pub fn shell(s: Shell, main: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                meta name="csrf-token" content=(s.csrf);
                title { (s.title) " · Docs" }
                (crate::assets().head())
            }
            body class=(s.body_class) {
                header.topbar {
                    @if s.body_class.contains("doc") {
                        button.nav-toggle type="button" aria-controls="doc-nav" aria-expanded="false" aria-label="Toggle page menu" { "☰" }
                    }
                    a.brand href="/" { "Docs" }
                    nav.topnav {
                        @if s.user.is_some() {
                            a href="/" { "Documents" }
                        }
                        a href="/components" { "Components" }
                    }
                    div.user-menu {
                        @if let Some(u) = s.user {
                            @if let Some(avatar) = &u.avatar_url {
                                img.avatar src=(avatar) alt="" width="24" height="24";
                            }
                            span.login { (u.login) }
                            a href="/settings/tokens" { "Access" }
                            form method="post" action="/logout" {
                                input type="hidden" name="csrf" value=(s.csrf);
                                button.link type="submit" { "Sign out" }
                            }
                        } @else {
                            a href="/login" { "Sign in" }
                        }
                    }
                }
                (main)
            }
        }
    }
}

pub fn simple(title: &str, user: Option<&User>, csrf: &str, body: Markup) -> Markup {
    shell(
        Shell {
            title,
            user,
            csrf,
            body_class: "",
        },
        html! { main.page { (body) } },
    )
}

pub fn error_page(status: StatusCode, msg: &str) -> Markup {
    simple(
        status.canonical_reason().unwrap_or("Error"),
        None,
        "",
        html! {
            h1 { (status.as_u16()) " " (status.canonical_reason().unwrap_or("")) }
            p { (msg) }
            p { a href="/" { "Back to documents" } }
        },
    )
}

/// `<time>` element; the frontend turns it into a relative, local time.
pub fn time(ts: i64) -> Markup {
    let dt = time::OffsetDateTime::from_unix_timestamp(ts).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let iso = dt
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let human = dt
        .format(time::macros::format_description!(
            "[year]-[month]-[day] [hour]:[minute] UTC"
        ))
        .unwrap_or_default();
    html! { time datetime=(iso) title=(human) { (human) } }
}
