use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    /// Public URL of the site, without a trailing slash.
    pub base_url: String,
    pub database_url: String,
    pub github: Option<GitHub>,
    /// Allow signing in with just a username. Never enable this on a public server.
    pub dev_login: bool,
    /// Lowercase logins allowed to sign in; everyone when `None`.
    pub allowed_users: Option<Vec<String>>,
    /// Vite+ build output (`frontend/dist`).
    pub assets_dir: PathBuf,
    /// When set, load scripts from a running `vp dev` server instead of the build.
    pub vite_dev_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitHub {
    pub client_id: String,
    pub client_secret: String,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind: SocketAddr = var("DOCS_BIND")
            .unwrap_or_else(|| "127.0.0.1:3000".into())
            .parse()
            .context("DOCS_BIND must look like 127.0.0.1:3000")?;
        let base_url = var("DOCS_BASE_URL")
            .unwrap_or_else(|| format!("http://localhost:{}", bind.port()))
            .trim_end_matches('/')
            .to_string();
        let github = match (var("GITHUB_CLIENT_ID"), var("GITHUB_CLIENT_SECRET")) {
            (Some(client_id), Some(client_secret)) => Some(GitHub {
                client_id,
                client_secret,
            }),
            _ => None,
        };
        Ok(Config {
            bind,
            base_url,
            database_url: var("DOCS_DATABASE_URL").unwrap_or_else(|| "sqlite://docs.db".into()),
            github,
            dev_login: matches!(var("DOCS_DEV_LOGIN").as_deref(), Some("1" | "true" | "yes")),
            allowed_users: var("DOCS_ALLOWED_USERS").map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            }),
            assets_dir: var("DOCS_ASSETS_DIR").unwrap_or_else(|| "frontend/dist".into()).into(),
            vite_dev_url: var("DOCS_VITE_DEV_URL").map(|u| u.trim_end_matches('/').to_string()),
        })
    }

    pub fn secure_cookies(&self) -> bool {
        self.base_url.starts_with("https://")
    }

    pub fn user_allowed(&self, login: &str) -> bool {
        match &self.allowed_users {
            Some(list) => list.iter().any(|u| *u == login.to_lowercase()),
            None => true,
        }
    }

    /// Settings for tests: in-memory database and dev login.
    pub fn for_tests() -> Self {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            base_url: "http://docs.test".into(),
            database_url: "sqlite::memory:".into(),
            github: None,
            dev_login: true,
            allowed_users: None,
            assets_dir: "frontend/dist".into(),
            vite_dev_url: None,
        }
    }
}
