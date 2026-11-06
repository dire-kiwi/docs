//! End-to-end tests against the router with an in-memory database.

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use docs::config::Config;
use docs::{AppState, db};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct TestApp {
    app: Router,
    state: AppState,
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
    fn location(&self) -> String {
        self.headers
            .get(header::LOCATION)
            .expect("location header")
            .to_str()
            .unwrap()
            .to_string()
    }
}

impl TestApp {
    async fn new() -> Self {
        let state = AppState::new(Config::for_tests()).await.unwrap();
        TestApp {
            app: docs::app(state.clone()),
            state,
        }
    }

    async fn send(&self, req: Request<Body>) -> Resp {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Resp {
            status,
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    /// A user with a browser session cookie and a personal access token.
    async fn user(&self, login: &str) -> (String, String) {
        let user = db::upsert_user(&self.state.db, "dev", login, login, None, None)
            .await
            .unwrap();
        let session = db::create_session(&self.state.db, user.id).await.unwrap();
        let pat = db::create_token(&self.state.db, "pat", user.id, None, Some("test"), None)
            .await
            .unwrap();
        (format!("docs_session={session}"), pat)
    }

    async fn get(&self, uri: &str, cookie: &str) -> Resp {
        self.send(
            Request::get(uri)
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    async fn rpc(&self, token: &str, method: &str, params: Value) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let res = self
            .send(
                Request::post("/mcp")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ACCEPT, "application/json, text/event-stream")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        res.json()
    }

    async fn tool(&self, token: &str, name: &str, args: Value) -> Value {
        let r = self
            .rpc(token, "tools/call", json!({ "name": name, "arguments": args }))
            .await;
        let result = &r["result"];
        assert_ne!(
            result["isError"],
            json!(true),
            "{name} failed: {}",
            result["content"][0]["text"]
        );
        result
            .get("structuredContent")
            .cloned()
            .unwrap_or_else(|| result["content"][0]["text"].clone())
    }

    async fn tool_error(&self, token: &str, name: &str, args: Value) -> String {
        let r = self
            .rpc(token, "tools/call", json!({ "name": name, "arguments": args }))
            .await;
        assert_eq!(r["result"]["isError"], json!(true), "{name} should fail: {r}");
        r["result"]["content"][0]["text"].as_str().unwrap().to_string()
    }

    async fn post_json(&self, uri: &str, cookie: &str, csrf: &str, body: Value) -> Resp {
        self.send(
            Request::post(uri)
                .header(header::COOKIE, cookie)
                .header("x-csrf-token", csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
    }
}

fn csrf_of(html: &str) -> String {
    let start = html.find("name=\"csrf-token\" content=\"").unwrap() + 27;
    html[start..start + html[start..].find('"').unwrap()].to_string()
}

fn attr_after(html: &str, marker: &str, attr: &str) -> String {
    let at = html.find(marker).unwrap_or_else(|| panic!("{marker} not in page"));
    let rest = &html[at..];
    let start = rest.find(&format!("{attr}=\"")).unwrap() + attr.len() + 2;
    rest[start..start + rest[start..].find('"').unwrap()].to_string()
}

const PLAN: &str = r#"---
title: Rollout plan
---

# Rollout plan

We will ship in two phases. See [phase 1](plan/phase-1.md).

<Callout type="warning">Downtime is expected.</Callout>

<RadioGroup name="window" label="Maintenance window" options={["Saturday", "Sunday"]} />

<Approval name="plan" label="Approve the plan?" />

<script>alert("xss")</script>
"#;

#[tokio::test]
async fn mcp_requires_a_token() {
    let t = TestApp::new().await;
    let res = t
        .send(
            Request::post("/mcp")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let challenge = res.headers.get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap();
    assert!(challenge.contains("resource_metadata=\"http://docs.test/.well-known/oauth-protected-resource/mcp\""));

    let meta = t
        .send(
            Request::get("/.well-known/oauth-protected-resource/mcp")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(meta.json()["authorization_servers"][0], "http://docs.test");
    let asm = t
        .send(
            Request::get("/.well-known/oauth-authorization-server")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(asm.json()["code_challenge_methods_supported"][0], "S256");
}

#[tokio::test]
async fn publish_view_and_collect_feedback() {
    let t = TestApp::new().await;
    let (cookie, token) = t.user("alice").await;

    let init = t.rpc(&token, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } })).await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let tools = t.rpc(&token, "tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"publish_document") && names.contains(&"get_feedback"));

    let published = t
        .tool(
            &token,
            "publish_document",
            json!({
                "slug": "rollout",
                "message": "first draft",
                "pages": [
                    { "path": "index.mdx", "content": PLAN },
                    { "path": "plan/phase-1", "content": "# Phase 1\n\nBack to [the plan](../index.md).\n\n<TextArea name=\"risks\" label=\"Risks?\" />" },
                    { "path": "plan/phase-2.md", "content": "# Phase 2\n\n- [ ] later" },
                ],
            }),
        )
        .await;
    assert_eq!(published["slug"], "rollout");
    assert_eq!(published["version"], 1);
    assert_eq!(published["url"], "http://docs.test/d/rollout/");
    assert_eq!(published["warnings"], json!([]));

    // Server-rendered page with nested menu, components and no script.
    let page = t.get("/d/rollout/", &cookie).await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.body);
    assert!(page.body.contains("<title>Rollout plan · Rollout plan · Docs</title>"));
    assert!(
        page.body.contains("href=\"/d/rollout/plan/phase-1\""),
        "relative link rewritten"
    );
    assert!(page.body.contains("callout-warning"));
    assert!(page.body.contains("data-field=\"window\""));
    assert!(!page.body.contains("alert(\"xss\")"));
    assert!(page.body.contains(">Phase 2</a>"), "nested menu");
    let csrf = csrf_of(&page.body);
    let version_id: i64 = attr_after(&page.body, "<article", "data-version-id").parse().unwrap();

    // Sub page, and unauthenticated access redirects to login.
    let sub = t.get("/d/rollout/plan/phase-1", &cookie).await;
    assert!(sub.body.contains("href=\"/d/rollout/\""));
    let anon = t.get("/d/rollout/", "").await;
    assert_eq!(anon.status, StatusCode::SEE_OTHER);
    assert_eq!(anon.location(), "/login?next=%2Fd%2Frollout%2F");

    // Answers and selections.
    let saved = t
        .post_json(
            "/api/responses",
            &cookie,
            &csrf,
            json!({ "version_id": version_id, "page": "index", "field": "window", "value": "Sunday" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let approval = json!({ "decision": "changes", "comment": "Need a rollback plan" });
    let saved = t
        .post_json(
            "/api/responses",
            &cookie,
            &csrf,
            json!({ "version_id": version_id, "page": "index", "field": "plan", "value": approval }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK);
    let bad_field = t
        .post_json(
            "/api/responses",
            &cookie,
            &csrf,
            json!({ "version_id": version_id, "page": "index", "field": "nope", "value": 1 }),
        )
        .await;
    assert_eq!(bad_field.status, StatusCode::BAD_REQUEST);
    let no_csrf = t
        .post_json(
            "/api/responses",
            &cookie,
            "wrong",
            json!({ "version_id": version_id, "page": "index", "field": "window", "value": "x" }),
        )
        .await;
    assert_eq!(no_csrf.status, StatusCode::FORBIDDEN);
    let sel = t
        .post_json(
            "/api/selections",
            &cookie,
            &csrf,
            json!({ "version_id": version_id, "page": "index", "quote": "two phases", "prefix": "We will ship in ", "suffix": ". See", "comment": "Why not one?" }),
        )
        .await;
    assert_eq!(sel.status, StatusCode::CREATED, "{}", sel.body);

    // The answer is pre-filled and the comment listed when the page is reloaded.
    let page = t.get("/d/rollout/", &cookie).await;
    assert!(page.body.contains("value=\"Sunday\" checked"), "answer prefilled");
    assert!(page.body.contains("Why not one?"));

    let feedback = t.tool(&token, "get_feedback", json!({ "slug": "rollout" })).await;
    let responses = feedback["responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2);
    let window = responses.iter().find(|r| r["field"] == "window").unwrap();
    assert_eq!(window["value"], "Sunday");
    assert_eq!(window["label"], "Maintenance window");
    assert_eq!(window["user"], "alice");
    assert_eq!(
        responses.iter().find(|r| r["field"] == "plan").unwrap()["value"],
        approval
    );
    assert_eq!(feedback["selections"][0]["quote"], "two phases");
    assert_eq!(feedback["selections"][0]["comment"], "Why not one?");

    let later = t
        .tool(
            &token,
            "get_feedback",
            json!({ "slug": "rollout", "since": feedback["cursor"].as_i64().unwrap() + 1 }),
        )
        .await;
    assert_eq!(later["responses"], json!([]));
}

#[tokio::test]
async fn versions_merge_and_validation() {
    let t = TestApp::new().await;
    let (cookie, token) = t.user("bob").await;
    t.tool(
        &token,
        "publish_document",
        json!({ "title": "Research notes", "pages": [{ "path": "a", "content": "# A" }, { "path": "b", "content": "# B" }] }),
    )
    .await;
    let v2 = t
        .tool(
            &token,
            "publish_document",
            json!({ "slug": "research-notes", "mode": "merge", "message": "update a", "pages": [{ "path": "a", "content": "# A v2" }] }),
        )
        .await;
    assert_eq!(v2["version"], 2);
    assert_eq!(v2["pages"].as_array().unwrap().len(), 2, "merge keeps page b");

    let old = t
        .tool(
            &token,
            "read_page",
            json!({ "slug": "research-notes", "path": "a", "version": 1 }),
        )
        .await;
    assert_eq!(old["content"], "# A");
    let new = t
        .tool(&token, "read_page", json!({ "slug": "research-notes", "path": "a" }))
        .await;
    assert_eq!(new["content"], "# A v2");

    // No index page: the document root opens the first page.
    let root = t.get("/d/research-notes/", &cookie).await;
    assert_eq!(root.status, StatusCode::SEE_OTHER);
    assert_eq!(root.location(), "/d/research-notes/a");
    let v1 = t.get("/d/research-notes/-/v/1/a", &cookie).await;
    assert!(v1.body.contains("You are viewing version 1"));
    let versions = t.get("/d/research-notes/-/versions", &cookie).await;
    assert!(versions.body.contains("update a"));

    let err = t
        .tool_error(
            &token,
            "publish_document",
            json!({ "slug": "broken", "pages": [{ "path": "x.mdx", "content": "<Callout>\n\nnever closed" }] }),
        )
        .await;
    assert!(err.contains("not valid mdx"), "{err}");

    let (_, other) = t.user("mallory").await;
    let err = t
        .tool_error(
            &other,
            "publish_document",
            json!({ "slug": "research-notes", "pages": [{ "path": "a", "content": "pwned" }] }),
        )
        .await;
    assert!(err.contains("belongs to another user"), "{err}");

    let warn = t
        .tool(
            &token,
            "publish_document",
            json!({ "title": "W", "pages": [{ "path": "index", "content": "<Chart />", "format": "mdx" }] }),
        )
        .await;
    assert!(
        warn["warnings"][0]["warning"]
            .as_str()
            .unwrap()
            .contains("unknown component <Chart>")
    );
}

#[tokio::test]
async fn oauth_authorization_code_flow() {
    let t = TestApp::new().await;
    let (cookie, _) = t.user("carol").await;

    let reg = t
        .send(
            Request::post("/oauth/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "client_name": "Test Agent", "redirect_uris": ["http://localhost:4444/cb"] }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(reg.status, StatusCode::CREATED, "{}", reg.body);
    let client_id = reg.json()["client_id"].as_str().unwrap().to_string();

    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    let authorize = format!(
        "/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Flocalhost%3A4444%2Fcb&code_challenge={challenge}&code_challenge_method=S256&state=xyz&resource=http%3A%2F%2Fdocs.test%2Fmcp"
    );
    let anon = t.get(&authorize, "").await;
    assert_eq!(anon.status, StatusCode::SEE_OTHER, "must sign in first");
    let consent = t.get(&authorize, &cookie).await;
    assert_eq!(consent.status, StatusCode::OK, "{}", consent.body);
    assert!(consent.body.contains("Connect Test Agent?"));
    let csrf = csrf_of(&consent.body);

    let form = serde_urlencoded::to_string([
        ("csrf", csrf.as_str()),
        ("decision", "allow"),
        ("client_id", &client_id),
        ("redirect_uri", "http://localhost:4444/cb"),
        ("code_challenge", challenge),
        ("state", "xyz"),
    ])
    .unwrap();
    let decided = t
        .send(
            Request::post("/oauth/authorize")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(form))
                .unwrap(),
        )
        .await;
    assert_eq!(decided.status, StatusCode::SEE_OTHER, "{}", decided.body);
    let redirect = url::Url::parse(&decided.location()).unwrap();
    assert_eq!(redirect.path(), "/cb");
    let q: std::collections::HashMap<_, _> = redirect.query_pairs().into_owned().collect();
    assert_eq!(q["state"], "xyz");
    let code = q["code"].clone();

    let token_req = |body: String| {
        Request::post("/oauth/token")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(body))
            .unwrap()
    };
    let wrong = t
        .send(token_req(
            serde_urlencoded::to_string([
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("client_id", &client_id),
                ("code_verifier", "wrong-verifier-wrong-verifier-wrong-verifier-123"),
            ])
            .unwrap(),
        ))
        .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong.json()["error"], "invalid_grant");

    // The code was consumed by the failed attempt, so get a fresh one.
    let user = db::upsert_user(&t.state.db, "dev", "carol", "carol", None, None)
        .await
        .unwrap();
    let code = db::create_code(
        &t.state.db,
        &client_id,
        user.id,
        "http://localhost:4444/cb",
        challenge,
        None,
    )
    .await
    .unwrap();
    let ok = t
        .send(token_req(
            serde_urlencoded::to_string([
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("client_id", &client_id),
                ("redirect_uri", "http://localhost:4444/cb"),
                ("code_verifier", verifier),
            ])
            .unwrap(),
        ))
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let tokens = ok.json();
    let access = tokens["access_token"].as_str().unwrap();
    let docs = t.tool(access, "list_documents", json!({})).await;
    assert_eq!(docs["documents"], json!([]));

    let refreshed = t
        .send(token_req(
            serde_urlencoded::to_string([
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
            ])
            .unwrap(),
        ))
        .await;
    assert_eq!(refreshed.status, StatusCode::OK);
    let reused = t
        .send(token_req(
            serde_urlencoded::to_string([
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
            ])
            .unwrap(),
        ))
        .await;
    assert_eq!(reused.status, StatusCode::BAD_REQUEST, "refresh tokens rotate");
}

#[tokio::test]
async fn dev_login_sets_a_session() {
    let t = TestApp::new().await;
    let res = t
        .send(
            Request::post("/auth/dev")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from("login=dave&next=%2Fcomponents"))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status, StatusCode::SEE_OTHER);
    assert_eq!(res.location(), "/components");
    let cookie = res.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
    let session = cookie.split(';').next().unwrap();
    let home = t.get("/", session).await;
    assert_eq!(home.status, StatusCode::OK);
    assert!(home.body.contains("dave"));
    let components = t.get("/components", "").await;
    assert!(components.body.contains("&lt;Approval&gt;"));
}
