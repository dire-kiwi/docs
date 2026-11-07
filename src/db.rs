//! SQLite storage.

use std::collections::HashMap;
use std::str::FromStr;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};

pub type Db = SqlitePool;

pub async fn connect(url: &str) -> Result<Db> {
    let opts = SqliteConnectOptions::from_str(url)
        .with_context(|| format!("bad database url {url}"))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    // In-memory databases are per-connection, so keep a single one.
    let max = if url.contains(":memory:") { 1 } else { 8 };
    let pool = SqlitePoolOptions::new().max_connections(max).connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// 256 random bits, base64url encoded.
pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("system random number generator");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct User {
    pub id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

pub async fn upsert_user(
    db: &Db,
    provider: &str,
    provider_id: &str,
    login: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
) -> Result<User> {
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (provider, provider_id, login, name, avatar_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_id) DO UPDATE SET
           login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url
         RETURNING id, login, name, avatar_url",
    )
    .bind(provider)
    .bind(provider_id)
    .bind(login)
    .bind(name)
    .bind(avatar_url)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(user)
}

pub async fn get_user(db: &Db, id: i64) -> Result<Option<User>> {
    Ok(
        sqlx::query_as::<_, User>("SELECT id, login, name, avatar_url FROM users WHERE id = ?")
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

// ---------- sessions ----------

pub const SESSION_TTL: i64 = 30 * 24 * 3600;

/// Returns the cookie value.
pub async fn create_session(db: &Db, user_id: i64) -> Result<String> {
    let token = random_token();
    sqlx::query("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(random_token())
        .bind(now() + SESSION_TTL)
        .execute(db)
        .await?;
    Ok(token)
}

/// The signed-in user and their CSRF token.
pub async fn session_user(db: &Db, token: &str) -> Result<Option<(User, String)>> {
    #[derive(FromRow)]
    struct Row {
        id: i64,
        login: String,
        name: Option<String>,
        avatar_url: Option<String>,
        csrf: String,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT u.id, u.login, u.name, u.avatar_url, s.csrf FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?",
    )
    .bind(hash_token(token))
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| {
        (
            User {
                id: r.id,
                login: r.login,
                name: r.name,
                avatar_url: r.avatar_url,
            },
            r.csrf,
        )
    }))
}

pub async fn delete_session(db: &Db, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = ? OR expires_at < ?")
        .bind(hash_token(token))
        .bind(now())
        .execute(db)
        .await?;
    Ok(())
}

// ---------- bearer tokens ----------

pub const ACCESS_TTL: i64 = 3600;
pub const REFRESH_TTL: i64 = 90 * 24 * 3600;

pub async fn create_token(
    db: &Db,
    kind: &str,
    user_id: i64,
    client_id: Option<&str>,
    name: Option<&str>,
    ttl: Option<i64>,
) -> Result<String> {
    let token = format!("{}_{}", if kind == "pat" { "dpat" } else { "doat" }, random_token());
    sqlx::query(
        "INSERT INTO tokens (hash, kind, user_id, client_id, name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(kind)
    .bind(user_id)
    .bind(client_id)
    .bind(name)
    .bind(now())
    .bind(ttl.map(|t| now() + t))
    .execute(db)
    .await?;
    Ok(token)
}

/// User for an access token or personal access token.
pub async fn bearer_user(db: &Db, token: &str) -> Result<Option<User>> {
    let hash = hash_token(token);
    let user = sqlx::query_as::<_, User>(
        "SELECT u.id, u.login, u.name, u.avatar_url FROM tokens t JOIN users u ON u.id = t.user_id
         WHERE t.hash = ? AND t.kind IN ('access', 'pat') AND (t.expires_at IS NULL OR t.expires_at > ?)",
    )
    .bind(&hash)
    .bind(now())
    .fetch_optional(db)
    .await?;
    if user.is_some() {
        sqlx::query("UPDATE tokens SET last_used_at = ? WHERE hash = ?")
            .bind(now())
            .bind(&hash)
            .execute(db)
            .await?;
    }
    Ok(user)
}

/// Consume a refresh token (they rotate on every use). Returns `(user_id, client_id)`.
pub async fn take_refresh_token(db: &Db, token: &str) -> Result<Option<(i64, String)>> {
    let row: Option<(i64, Option<String>)> = sqlx::query_as(
        "DELETE FROM tokens WHERE hash = ? AND kind = 'refresh' AND expires_at > ?
         RETURNING user_id, client_id",
    )
    .bind(hash_token(token))
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(u, c)| (u, c.unwrap_or_default())))
}

#[derive(Debug, FromRow, Serialize)]
pub struct TokenInfo {
    pub id: i64,
    pub kind: String,
    pub name: Option<String>,
    pub client_name: Option<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// Personal access tokens and OAuth grants (refresh tokens) of a user.
pub async fn list_tokens(db: &Db, user_id: i64) -> Result<Vec<TokenInfo>> {
    Ok(sqlx::query_as::<_, TokenInfo>(
        "SELECT t.id, t.kind, t.name, c.client_name, t.created_at, t.last_used_at FROM tokens t
         LEFT JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.kind IN ('pat', 'refresh') AND (t.expires_at IS NULL OR t.expires_at > ?)
         ORDER BY t.created_at DESC",
    )
    .bind(user_id)
    .bind(now())
    .fetch_all(db)
    .await?)
}

/// Revoke a token. Revoking an OAuth grant also revokes the client's access tokens.
pub async fn revoke_token(db: &Db, user_id: i64, id: i64) -> Result<()> {
    let client: Option<(Option<String>,)> =
        sqlx::query_as("DELETE FROM tokens WHERE id = ? AND user_id = ? RETURNING client_id")
            .bind(id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    if let Some((Some(client_id),)) = client {
        sqlx::query("DELETE FROM tokens WHERE user_id = ? AND client_id = ? AND kind = 'access'")
            .bind(user_id)
            .bind(client_id)
            .execute(db)
            .await?;
    }
    Ok(())
}

// ---------- OAuth clients and codes ----------

#[derive(Debug, Clone)]
pub struct Client {
    pub client_id: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
}

pub async fn register_client(db: &Db, name: &str, redirect_uris: &[String]) -> Result<String> {
    let client_id = format!("client_{}", random_token());
    sqlx::query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
        .bind(&client_id)
        .bind(name)
        .bind(serde_json::to_string(redirect_uris)?)
        .bind(now())
        .execute(db)
        .await?;
    Ok(client_id)
}

pub async fn get_client(db: &Db, client_id: &str) -> Result<Option<Client>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
            .bind(client_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(client_id, client_name, uris)| Client {
        client_id,
        client_name,
        redirect_uris: serde_json::from_str(&uris).unwrap_or_default(),
    }))
}

pub struct Code {
    pub client_id: String,
    pub user_id: i64,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub scope: Option<String>,
}

pub async fn create_code(
    db: &Db,
    client_id: &str,
    user_id: i64,
    redirect_uri: &str,
    code_challenge: &str,
    scope: Option<&str>,
) -> Result<String> {
    let code = random_token();
    sqlx::query(
        "INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&code))
    .bind(client_id)
    .bind(user_id)
    .bind(redirect_uri)
    .bind(code_challenge)
    .bind(scope)
    .bind(now() + 600)
    .execute(db)
    .await?;
    Ok(code)
}

/// Codes are single use.
pub async fn take_code(db: &Db, code: &str) -> Result<Option<Code>> {
    let row: Option<(String, i64, String, String, Option<String>)> = sqlx::query_as(
        "DELETE FROM oauth_codes WHERE hash = ? AND expires_at > ?
         RETURNING client_id, user_id, redirect_uri, code_challenge, scope",
    )
    .bind(hash_token(code))
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(
        row.map(|(client_id, user_id, redirect_uri, code_challenge, scope)| Code {
            client_id,
            user_id,
            redirect_uri,
            code_challenge,
            scope,
        }),
    )
}

// ---------- device authorization (RFC 8628) ----------

pub const DEVICE_CODE_TTL: i64 = 600;
pub const DEVICE_POLL_INTERVAL: i64 = 5;
/// No vowels, so codes don't spell words; no digits, so nothing is mistaken for a letter.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";

/// Eight letters from [`USER_CODE_ALPHABET`] (about 34 bits).
fn random_user_code() -> String {
    let mut code = String::with_capacity(8);
    while code.len() < 8 {
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).expect("system random number generator");
        // Reject bytes past the largest multiple of 20 to keep the letters uniform.
        for b in buf.into_iter().filter(|b| *b < 240) {
            if code.len() < 8 {
                code.push(USER_CODE_ALPHABET[(b % 20) as usize] as char);
            }
        }
    }
    code
}

/// What people type is forgiving: case and separators don't matter.
pub fn normalize_user_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Returns `(device_code, user_code)`.
pub async fn create_device_code(db: &Db, client_id: &str) -> Result<(String, String)> {
    sqlx::query("DELETE FROM oauth_device_codes WHERE expires_at < ?")
        .bind(now())
        .execute(db)
        .await?;
    let device_code = random_token();
    let user_code = random_user_code();
    sqlx::query(
        "INSERT INTO oauth_device_codes (hash, user_code, client_id, interval, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&device_code))
    .bind(&user_code)
    .bind(client_id)
    .bind(DEVICE_POLL_INTERVAL)
    .bind(now() + DEVICE_CODE_TTL)
    .execute(db)
    .await?;
    Ok((device_code, user_code))
}

/// The client a pending, unexpired user code belongs to.
pub async fn pending_device_client(db: &Db, user_code: &str) -> Result<Option<Client>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT client_id FROM oauth_device_codes WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
    )
    .bind(normalize_user_code(user_code))
    .bind(now())
    .fetch_optional(db)
    .await?;
    match row {
        Some((client_id,)) => get_client(db, &client_id).await,
        None => Ok(None),
    }
}

/// Approve or deny a pending code. False if it is unknown, expired or already decided.
pub async fn decide_device_code(db: &Db, user_code: &str, user_id: i64, approve: bool) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE oauth_device_codes SET status = ?, user_id = ?
         WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
    )
    .bind(if approve { "approved" } else { "denied" })
    .bind(user_id)
    .bind(normalize_user_code(user_code))
    .bind(now())
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

#[derive(Debug, PartialEq)]
pub enum DevicePoll {
    Unknown,
    Expired,
    Pending,
    SlowDown,
    Denied,
    Approved { user_id: i64, client_id: String },
}

/// A token-endpoint poll with a device code. Decided codes are single use.
pub async fn poll_device_code(db: &Db, device_code: &str) -> Result<DevicePoll> {
    let hash = hash_token(device_code);
    #[derive(FromRow)]
    struct Row {
        client_id: String,
        status: String,
        user_id: Option<i64>,
        interval: i64,
        last_polled_at: Option<i64>,
        expires_at: i64,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT client_id, status, user_id, interval, last_polled_at, expires_at
         FROM oauth_device_codes WHERE hash = ?",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?;
    let Some(Row {
        client_id,
        status,
        user_id,
        interval,
        last_polled_at,
        expires_at,
    }) = row
    else {
        return Ok(DevicePoll::Unknown);
    };
    let now = now();
    if expires_at <= now {
        return Ok(DevicePoll::Expired);
    }
    if status != "pending" {
        // Delete first, so two concurrent polls can't both get tokens.
        let taken = sqlx::query("DELETE FROM oauth_device_codes WHERE hash = ? AND status = ?")
            .bind(&hash)
            .bind(&status)
            .execute(db)
            .await?;
        return Ok(match (taken.rows_affected(), status.as_str(), user_id) {
            (1, "approved", Some(user_id)) => DevicePoll::Approved { user_id, client_id },
            (1, _, _) => DevicePoll::Denied,
            _ => DevicePoll::Unknown,
        });
    }
    let too_soon = last_polled_at.is_some_and(|t| now - t < interval);
    // RFC 8628 3.5: on slow_down the client adds 5 seconds to its interval, and so do we.
    sqlx::query("UPDATE oauth_device_codes SET last_polled_at = ?, interval = interval + ? WHERE hash = ?")
        .bind(now)
        .bind(if too_soon { 5 } else { 0 })
        .bind(&hash)
        .execute(db)
        .await?;
    Ok(if too_soon {
        DevicePoll::SlowDown
    } else {
        DevicePoll::Pending
    })
}

// ---------- documents ----------

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct DocumentSummary {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub owner: String,
    pub owner_id: i64,
    pub latest_version: i64,
    pub page_count: i64,
    pub updated_at: i64,
}

const DOC_SUMMARY: &str = "SELECT d.id, d.slug, d.title, u.login AS owner, d.owner_id, d.updated_at,
    (SELECT MAX(number) FROM versions v WHERE v.document_id = d.id) AS latest_version,
    (SELECT COUNT(*) FROM pages p JOIN versions v ON v.id = p.version_id
       WHERE v.document_id = d.id AND v.number = (SELECT MAX(number) FROM versions WHERE document_id = d.id)) AS page_count
    FROM documents d JOIN users u ON u.id = d.owner_id";

/// Who can see a document: its owner and the people it is shared with.
const CAN_VIEW: &str =
    "(d.owner_id = ? OR EXISTS (SELECT 1 FROM document_shares s WHERE s.document_id = d.id AND s.login = ?))";

/// Documents `user` can see, most recently updated first.
pub async fn list_documents(db: &Db, user: &User) -> Result<Vec<DocumentSummary>> {
    Ok(
        sqlx::query_as::<_, DocumentSummary>(&format!("{DOC_SUMMARY} WHERE {CAN_VIEW} ORDER BY d.updated_at DESC"))
            .bind(user.id)
            .bind(user.login.to_lowercase())
            .fetch_all(db)
            .await?,
    )
}

/// A document, if `user` can see it.
pub async fn get_document(db: &Db, slug: &str, user: &User) -> Result<Option<DocumentSummary>> {
    Ok(
        sqlx::query_as::<_, DocumentSummary>(&format!("{DOC_SUMMARY} WHERE d.slug = ? AND {CAN_VIEW}"))
            .bind(slug)
            .bind(user.id)
            .bind(user.login.to_lowercase())
            .fetch_optional(db)
            .await?,
    )
}

/// Whether `user` can see the document a version belongs to.
pub async fn can_view_version(db: &Db, version_id: i64, user: &User) -> Result<bool> {
    let row = sqlx::query(&format!(
        "SELECT 1 FROM versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ? AND {CAN_VIEW}"
    ))
    .bind(version_id)
    .bind(user.id)
    .bind(user.login.to_lowercase())
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// Whether any document, visible or not, has this slug.
pub async fn slug_exists(db: &Db, slug: &str) -> Result<bool> {
    Ok(sqlx::query("SELECT 1 FROM documents WHERE slug = ?")
        .bind(slug)
        .fetch_optional(db)
        .await?
        .is_some())
}

// ---------- sharing ----------

/// Lowercased login, if it looks like one.
pub fn normalize_login(login: &str) -> Option<String> {
    let l = login.trim().trim_start_matches('@').to_lowercase();
    (!l.is_empty() && l.len() <= 100 && l.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))).then_some(l)
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Share {
    pub login: String,
    pub created_at: i64,
}

pub async fn shares(db: &Db, document_id: i64) -> Result<Vec<Share>> {
    Ok(
        sqlx::query_as::<_, Share>(
            "SELECT login, created_at FROM document_shares WHERE document_id = ? ORDER BY login",
        )
        .bind(document_id)
        .fetch_all(db)
        .await?,
    )
}

pub async fn add_share(db: &Db, document_id: i64, login: &str) -> Result<()> {
    sqlx::query("INSERT INTO document_shares (document_id, login, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(document_id)
        .bind(login)
        .bind(now())
        .execute(db)
        .await?;
    Ok(())
}

pub async fn remove_share(db: &Db, document_id: i64, login: &str) -> Result<()> {
    sqlx::query("DELETE FROM document_shares WHERE document_id = ? AND login = ?")
        .bind(document_id)
        .bind(login)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn share_token(db: &Db, document_id: i64) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT share_token FROM documents WHERE id = ?")
        .bind(document_id)
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|(t,)| t))
}

/// Turn the share link on (with a new secret) or off. Returns the new token.
pub async fn set_share_token(db: &Db, document_id: i64, enabled: bool) -> Result<Option<String>> {
    let token = enabled.then(random_token);
    sqlx::query("UPDATE documents SET share_token = ? WHERE id = ?")
        .bind(&token)
        .bind(document_id)
        .execute(db)
        .await?;
    Ok(token)
}

/// Opening a share link adds the user to the document's shares. Returns the slug.
pub async fn accept_share_link(db: &Db, token: &str, user: &User) -> Result<Option<String>> {
    let row: Option<(i64, String, i64)> =
        sqlx::query_as("SELECT id, slug, owner_id FROM documents WHERE share_token = ?")
            .bind(token)
            .fetch_optional(db)
            .await?;
    let Some((id, slug, owner)) = row else { return Ok(None) };
    if owner != user.id {
        add_share(db, id, &user.login.to_lowercase()).await?;
    }
    Ok(Some(slug))
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Version {
    pub id: i64,
    pub number: i64,
    pub message: Option<String>,
    pub author: String,
    pub created_at: i64,
}

const VERSION: &str = "SELECT v.id, v.number, v.message, u.login AS author, v.created_at
    FROM versions v JOIN users u ON u.id = v.created_by";

pub async fn versions(db: &Db, document_id: i64) -> Result<Vec<Version>> {
    Ok(
        sqlx::query_as::<_, Version>(&format!("{VERSION} WHERE v.document_id = ? ORDER BY v.number DESC"))
            .bind(document_id)
            .fetch_all(db)
            .await?,
    )
}

/// A specific version, or the latest when `number` is `None`.
pub async fn version(db: &Db, document_id: i64, number: Option<i64>) -> Result<Option<Version>> {
    let q = match number {
        Some(_) => format!("{VERSION} WHERE v.document_id = ? AND v.number = ?"),
        None => format!("{VERSION} WHERE v.document_id = ? ORDER BY v.number DESC LIMIT 1"),
    };
    let mut query = sqlx::query_as::<_, Version>(&q).bind(document_id);
    if let Some(n) = number {
        query = query.bind(n);
    }
    Ok(query.fetch_optional(db).await?)
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct PageSummary {
    pub path: String,
    pub title: String,
    pub format: String,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Page {
    pub path: String,
    pub title: String,
    pub format: String,
    pub source: String,
}

pub async fn pages(db: &Db, version_id: i64) -> Result<Vec<PageSummary>> {
    Ok(sqlx::query_as::<_, PageSummary>(
        "SELECT path, title, format FROM pages WHERE version_id = ? ORDER BY position, path",
    )
    .bind(version_id)
    .fetch_all(db)
    .await?)
}

pub async fn page(db: &Db, version_id: i64, path: &str) -> Result<Option<Page>> {
    Ok(
        sqlx::query_as::<_, Page>("SELECT path, title, format, source FROM pages WHERE version_id = ? AND path = ?")
            .bind(version_id)
            .bind(path)
            .fetch_optional(db)
            .await?,
    )
}

pub async fn all_pages(db: &Db, version_id: i64) -> Result<Vec<Page>> {
    Ok(sqlx::query_as::<_, Page>(
        "SELECT path, title, format, source FROM pages WHERE version_id = ? ORDER BY position, path",
    )
    .bind(version_id)
    .fetch_all(db)
    .await?)
}

/// A validated page ready to store.
pub struct NewPage {
    pub path: String,
    pub title: String,
    pub format: &'static str,
    pub source: String,
    pub position: i64,
}

pub struct Publish<'a> {
    pub user_id: i64,
    /// Document to add a version to; created when it does not exist yet.
    /// When `None`, a new document is created with a slug derived from the title.
    pub slug: Option<&'a str>,
    pub title: Option<&'a str>,
    pub message: Option<&'a str>,
    pub pages: Vec<NewPage>,
    /// Keep pages of the previous version that are not in `pages`.
    pub merge: bool,
    pub delete: Vec<String>,
}

/// Create a new version (and the document if needed). Returns `(slug, version number)`.
pub async fn publish(db: &Db, p: Publish<'_>) -> Result<(String, i64)> {
    let mut tx = db.begin().await?;
    let ts = now();
    let wanted = p.slug.map(doc_slug);
    let existing: Option<(i64, i64, String)> = match &wanted {
        Some(slug) => {
            sqlx::query_as("SELECT id, owner_id, slug FROM documents WHERE slug = ?")
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => None,
    };
    let (doc_id, slug) = match existing {
        Some((id, owner, slug)) => {
            if owner != p.user_id {
                bail!("the slug {slug:?} is taken by another user's document; choose a different slug, or omit it");
            }
            if let Some(title) = p.title {
                sqlx::query("UPDATE documents SET title = ? WHERE id = ?")
                    .bind(title)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            (id, slug)
        }
        None => {
            let title = p.title.unwrap_or("Untitled");
            let base = wanted.unwrap_or_else(|| doc_slug(title));
            let mut slug = base.clone();
            let mut n = 1;
            while sqlx::query("SELECT 1 FROM documents WHERE slug = ?")
                .bind(&slug)
                .fetch_optional(&mut *tx)
                .await?
                .is_some()
            {
                n += 1;
                slug = format!("{base}-{n}");
            }
            let (id,): (i64,) = sqlx::query_as(
                "INSERT INTO documents (slug, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(&slug)
            .bind(title)
            .bind(p.user_id)
            .bind(ts)
            .bind(ts)
            .fetch_one(&mut *tx)
            .await?;
            (id, slug)
        }
    };

    let prev: Option<(i64, i64)> =
        sqlx::query_as("SELECT id, number FROM versions WHERE document_id = ? ORDER BY number DESC LIMIT 1")
            .bind(doc_id)
            .fetch_optional(&mut *tx)
            .await?;
    let number = prev.map_or(1, |(_, n)| n + 1);
    let (version_id,): (i64,) = sqlx::query_as(
        "INSERT INTO versions (document_id, number, message, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(doc_id)
    .bind(number)
    .bind(p.message)
    .bind(p.user_id)
    .bind(ts)
    .fetch_one(&mut *tx)
    .await?;

    for page in &p.pages {
        sqlx::query("INSERT INTO pages (version_id, path, title, format, source, position) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(version_id)
            .bind(&page.path)
            .bind(&page.title)
            .bind(page.format)
            .bind(&page.source)
            .bind(page.position)
            .execute(&mut *tx)
            .await?;
    }
    if let (true, Some((prev_id, _))) = (p.merge, prev) {
        // Carry over untouched pages from the previous version.
        let old: Vec<(String, String, String, String, i64)> =
            sqlx::query_as("SELECT path, title, format, source, position FROM pages WHERE version_id = ?")
                .bind(prev_id)
                .fetch_all(&mut *tx)
                .await?;
        for (path, title, format, source, position) in old {
            if p.pages.iter().any(|np| np.path == path) || p.delete.contains(&path) {
                continue;
            }
            sqlx::query(
                "INSERT INTO pages (version_id, path, title, format, source, position) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(version_id)
            .bind(path)
            .bind(title)
            .bind(format)
            .bind(source)
            .bind(position)
            .execute(&mut *tx)
            .await?;
        }
    }
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages WHERE version_id = ?")
        .bind(version_id)
        .fetch_one(&mut *tx)
        .await?;
    if count == 0 {
        bail!("a version needs at least one page");
    }
    sqlx::query("UPDATE documents SET updated_at = ? WHERE id = ?")
        .bind(ts)
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((slug, number))
}

pub fn doc_slug(title: &str) -> String {
    let mut s = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 60 {
            break;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "doc".into() } else { s }
}

pub async fn delete_document(db: &Db, user_id: i64, slug: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM documents WHERE slug = ? AND owner_id = ?")
        .bind(slug)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ---------- feedback ----------

pub async fn save_response(
    db: &Db,
    version_id: i64,
    page_path: &str,
    field: &str,
    user_id: i64,
    value: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO responses (version_id, page_path, field, user_id, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (version_id, page_path, field, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(version_id)
    .bind(page_path)
    .bind(field)
    .bind(user_id)
    .bind(value.to_string())
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn user_answers(
    db: &Db,
    version_id: i64,
    page_path: &str,
    user_id: i64,
) -> Result<HashMap<String, serde_json::Value>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT field, value FROM responses WHERE version_id = ? AND page_path = ? AND user_id = ?")
            .bind(version_id)
            .bind(page_path)
            .bind(user_id)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(f, v)| serde_json::from_str(&v).ok().map(|v| (f, v)))
        .collect())
}

pub struct NewSelection<'a> {
    pub version_id: i64,
    pub page_path: &'a str,
    pub user_id: i64,
    pub quote: &'a str,
    pub prefix: &'a str,
    pub suffix: &'a str,
    pub comment: &'a str,
}

pub async fn add_selection(db: &Db, s: NewSelection<'_>) -> Result<i64> {
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO selections (version_id, page_path, user_id, quote, prefix, suffix, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(s.version_id)
    .bind(s.page_path)
    .bind(s.user_id)
    .bind(s.quote)
    .bind(s.prefix)
    .bind(s.suffix)
    .bind(s.comment)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(id)
}

pub async fn delete_selection(db: &Db, id: i64, user_id: i64) -> Result<bool> {
    let res = sqlx::query("DELETE FROM selections WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Selection {
    pub id: i64,
    pub version: i64,
    pub page: String,
    pub user: String,
    #[serde(skip)]
    pub user_id: i64,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub comment: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Response {
    pub version: i64,
    pub page: String,
    pub field: String,
    pub user: String,
    #[serde(skip)]
    pub value_json: String,
    pub updated_at: i64,
}

impl Response {
    pub fn value(&self) -> serde_json::Value {
        serde_json::from_str(&self.value_json).unwrap_or(serde_json::Value::Null)
    }
}

pub async fn page_selections(db: &Db, version_id: i64, page_path: &str) -> Result<Vec<Selection>> {
    Ok(sqlx::query_as::<_, Selection>(
        "SELECT s.id, v.number AS version, s.page_path AS page, u.login AS user, s.user_id, s.quote, s.prefix,
                s.suffix, s.comment, s.created_at
         FROM selections s JOIN users u ON u.id = s.user_id JOIN versions v ON v.id = s.version_id
         WHERE s.version_id = ? AND s.page_path = ? ORDER BY s.created_at",
    )
    .bind(version_id)
    .bind(page_path)
    .fetch_all(db)
    .await?)
}

/// All feedback on a document, optionally limited to one version and to items changed at or after `since`.
pub async fn feedback(
    db: &Db,
    document_id: i64,
    version: Option<i64>,
    since: i64,
) -> Result<(Vec<Response>, Vec<Selection>)> {
    let version = version.unwrap_or(-1);
    let responses = sqlx::query_as::<_, Response>(
        "SELECT v.number AS version, r.page_path AS page, r.field, u.login AS user, r.value AS value_json, r.updated_at
         FROM responses r JOIN versions v ON v.id = r.version_id JOIN users u ON u.id = r.user_id
         WHERE v.document_id = ? AND (? = -1 OR v.number = ?) AND r.updated_at >= ?
         ORDER BY v.number, r.page_path, r.updated_at",
    )
    .bind(document_id)
    .bind(version)
    .bind(version)
    .bind(since)
    .fetch_all(db)
    .await?;
    let selections = sqlx::query_as::<_, Selection>(
        "SELECT s.id, v.number AS version, s.page_path AS page, u.login AS user, s.user_id, s.quote, s.prefix,
                s.suffix, s.comment, s.created_at
         FROM selections s JOIN versions v ON v.id = s.version_id JOIN users u ON u.id = s.user_id
         WHERE v.document_id = ? AND (? = -1 OR v.number = ?) AND s.created_at >= ?
         ORDER BY v.number, s.page_path, s.created_at",
    )
    .bind(document_id)
    .bind(version)
    .bind(version)
    .bind(since)
    .fetch_all(db)
    .await?;
    Ok((responses, selections))
}
