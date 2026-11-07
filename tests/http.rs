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
    assert!(err.contains("is taken by another user"), "{err}");

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
    // Naming another client doesn't use up the code.
    let other_client = t
        .send(token_req(
            serde_urlencoded::to_string([
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("client_id", "client_other"),
                ("code_verifier", verifier),
            ])
            .unwrap(),
        ))
        .await;
    assert_eq!(other_client.status, StatusCode::BAD_REQUEST);
    assert_eq!(other_client.json()["error"], "invalid_grant");
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
    assert_eq!(
        wrong.json()["error_description"],
        "PKCE verification failed",
        "the code survived the other client's attempt"
    );

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

#[tokio::test]
async fn removing_a_user_from_the_allowlist_revokes_access() {
    let t = TestApp::new().await;
    let (cookie, pat) = t.user("erin").await;
    let user = db::upsert_user(&t.state.db, "dev", "erin", "erin", None, None)
        .await
        .unwrap();
    let client_id = db::register_client(
        &t.state.db,
        "Agent",
        &["http://localhost:1/cb".to_string()],
        &["authorization_code", "refresh_token"],
    )
    .await
    .unwrap();
    let refresh = db::create_token(
        &t.state.db,
        "refresh",
        user.id,
        Some(&client_id),
        None,
        Some(db::REFRESH_TTL),
    )
    .await
    .unwrap();
    assert_eq!(t.get("/", &cookie).await.status, StatusCode::OK);

    // Same database, restarted with an allowlist that no longer includes erin.
    let mut config = Config::for_tests();
    config.allowed_users = Some(vec!["someone-else".into()]);
    let state = AppState {
        db: t.state.db.clone(),
        config: std::sync::Arc::new(config),
        http: t.state.http.clone(),
    };
    let t = TestApp {
        app: docs::app(state.clone()),
        state,
    };

    let page = t.get("/", &cookie).await;
    assert_eq!(page.status, StatusCode::SEE_OTHER, "session no longer signs erin in");
    assert!(page.location().starts_with("/login"));

    let mcp = t
        .send(
            Request::post("/mcp")
                .header(header::AUTHORIZATION, format!("Bearer {pat}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(mcp.status, StatusCode::UNAUTHORIZED, "personal access token rejected");

    let token = t
        .send(
            Request::post("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(
                    serde_urlencoded::to_string([("grant_type", "refresh_token"), ("refresh_token", refresh.as_str())])
                        .unwrap(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(token.status, StatusCode::BAD_REQUEST, "{}", token.body);
    assert_eq!(token.json()["error"], "invalid_grant");
}

#[tokio::test]
async fn documents_are_private_until_shared() {
    let t = TestApp::new().await;
    let (alice_cookie, alice) = t.user("alice").await;
    let (bob_cookie, bob) = t.user("bob").await;
    let (carol_cookie, carol) = t.user("carol").await;
    t.tool(
        &alice,
        "publish_document",
        json!({ "slug": "secret", "pages": [{ "path": "index", "content": "# Secret\n\n<TextInput name=\"q\" label=\"Q\" />" }] }),
    )
    .await;

    // Bob can't see it anywhere.
    assert_eq!(t.get("/d/secret/", &bob_cookie).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        t.get("/d/secret/-/feedback", &bob_cookie).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(t.tool(&bob, "list_documents", json!({})).await["documents"], json!([]));
    let err = t.tool_error(&bob, "get_feedback", json!({ "slug": "secret" })).await;
    assert!(err.contains("no document"), "{err}");
    let page = t.get("/d/secret/", &alice_cookie).await;
    let version_id: i64 = attr_after(&page.body, "<article", "data-version-id").parse().unwrap();
    let bob_home = t.get("/", &bob_cookie).await;
    let saved = t
        .post_json(
            "/api/responses",
            &bob_cookie,
            &csrf_of(&bob_home.body),
            json!({ "version_id": version_id, "page": "index", "field": "q", "value": "x" }),
        )
        .await;
    assert_eq!(
        saved.status,
        StatusCode::BAD_REQUEST,
        "can't answer a document you can't see"
    );
    let err = t
        .tool_error(
            &bob,
            "share_document",
            json!({ "slug": "secret", "add_users": ["bob"] }),
        )
        .await;
    assert!(err.contains("no document"), "{err}");

    // Shared by username: bob can read it and answer, but not publish or share.
    let shared = t
        .tool(
            &alice,
            "share_document",
            json!({ "slug": "secret", "add_users": ["Bob"] }),
        )
        .await;
    assert_eq!(shared["shared_with"], json!(["bob"]));
    assert_eq!(shared["share_link"], Value::Null);
    let page = t.get("/d/secret/", &bob_cookie).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.body.contains("Shared by alice"));
    let saved = t
        .post_json(
            "/api/responses",
            &bob_cookie,
            &csrf_of(&page.body),
            json!({ "version_id": version_id, "page": "index", "field": "q", "value": "from bob" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK);
    let listed = t.tool(&bob, "list_documents", json!({})).await;
    assert_eq!(listed["documents"][0]["shared_with_you"], true);
    let err = t
        .tool_error(
            &bob,
            "share_document",
            json!({ "slug": "secret", "add_users": ["carol"] }),
        )
        .await;
    assert!(err.contains("only the owner"), "{err}");
    assert_eq!(
        t.get("/d/secret/-/share", &bob_cookie).await.status,
        StatusCode::FORBIDDEN
    );
    let err = t
        .tool_error(
            &bob,
            "publish_document",
            json!({ "slug": "secret", "pages": [{ "path": "index", "content": "x" }] }),
        )
        .await;
    assert!(err.contains("taken by another user"), "{err}");

    // Share link: carol joins by opening it; turning it off stops new joins.
    let shared = t
        .tool(&alice, "share_document", json!({ "slug": "secret", "link": "enable" }))
        .await;
    let link = shared["share_link"].as_str().unwrap().to_string();
    let path = link.strip_prefix("http://docs.test").unwrap();
    assert_eq!(
        t.get(path, "").await.status,
        StatusCode::SEE_OTHER,
        "must sign in first"
    );
    let joined = t.get(path, &carol_cookie).await;
    assert_eq!(joined.location(), "/d/secret/");
    assert_eq!(t.get("/d/secret/", &carol_cookie).await.status, StatusCode::OK);
    let (dave_cookie, _) = t.user("dave").await;
    t.tool(&alice, "share_document", json!({ "slug": "secret", "link": "disable" }))
        .await;
    assert_eq!(t.get(path, &dave_cookie).await.status, StatusCode::NOT_FOUND);

    // Removing a person revokes their access, including their agent's.
    let shared = t
        .tool(
            &alice,
            "share_document",
            json!({ "slug": "secret", "remove_users": ["carol"] }),
        )
        .await;
    assert_eq!(shared["shared_with"], json!(["bob"]));
    assert_eq!(t.get("/d/secret/", &carol_cookie).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        t.tool(&carol, "list_documents", json!({})).await["documents"],
        json!([])
    );

    // The owner's share page lists people and manages the link.
    let share_page = t.get("/d/secret/-/share", &alice_cookie).await;
    assert_eq!(share_page.status, StatusCode::OK);
    assert!(share_page.body.contains("bob") && share_page.body.contains("Link sharing is off"));
    let form = serde_urlencoded::to_string([
        ("csrf", csrf_of(&share_page.body).as_str()),
        ("action", "add"),
        ("login", "erin"),
    ])
    .unwrap();
    let res = t
        .send(
            Request::post("/d/secret/-/share")
                .header(header::COOKIE, &alice_cookie)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(form))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status, StatusCode::SEE_OTHER);
    assert!(t.get("/d/secret/-/share", &alice_cookie).await.body.contains("erin"));
}

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

impl TestApp {
    async fn post_form(&self, uri: &str, cookie: &str, form: &[(&str, &str)]) -> Resp {
        self.send(
            Request::post(uri)
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(serde_urlencoded::to_string(form).unwrap()))
                .unwrap(),
        )
        .await
    }

    /// Register a device-only client, as Huntaway does.
    async fn device_client(&self) -> String {
        let reg = self
            .send(
                Request::post("/oauth/register")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "client_name": "Huntaway", "grant_types": [DEVICE_GRANT, "refresh_token"] })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(reg.status, StatusCode::CREATED, "{}", reg.body);
        let reg = reg.json();
        assert_eq!(reg["grant_types"], json!([DEVICE_GRANT, "refresh_token"]));
        assert_eq!(reg["redirect_uris"], json!([]));
        reg["client_id"].as_str().unwrap().to_string()
    }

    async fn start_device(&self, client_id: &str) -> Value {
        let res = self
            .post_form(
                "/oauth/device_authorization",
                "",
                &[("client_id", client_id), ("scope", "docs")],
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        res.json()
    }

    async fn poll(&self, client_id: &str, device_code: &str) -> Resp {
        self.post_form(
            "/oauth/token",
            "",
            &[
                ("grant_type", DEVICE_GRANT),
                ("device_code", device_code),
                ("client_id", client_id),
            ],
        )
        .await
    }

    /// Open the verification link as a signed-in user and allow or deny.
    async fn decide_device(&self, cookie: &str, user_code: &str, decision: &str) -> Resp {
        let page = self.get(&format!("/device?user_code={user_code}"), cookie).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.body);
        assert!(page.body.contains("Connect Huntaway?"), "{}", page.body);
        assert!(page.body.contains(user_code));
        let csrf = csrf_of(&page.body);
        self.post_form(
            "/device",
            cookie,
            &[("csrf", &csrf), ("user_code", user_code), ("decision", decision)],
        )
        .await
    }
}

fn error_of(res: &Resp) -> String {
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.body);
    res.json()["error"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn oauth_device_flow_publishes_as_the_user() {
    let t = TestApp::new().await;
    let asm = t
        .send(
            Request::get("/.well-known/oauth-authorization-server")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .json();
    assert_eq!(
        asm["device_authorization_endpoint"],
        "http://docs.test/oauth/device_authorization"
    );
    assert!(
        asm["grant_types_supported"]
            .as_array()
            .unwrap()
            .contains(&json!(DEVICE_GRANT))
    );

    let client_id = t.device_client().await;
    let start = t.start_device(&client_id).await;
    let device_code = start["device_code"].as_str().unwrap();
    let user_code = start["user_code"].as_str().unwrap();
    assert_eq!(start["verification_uri"], "http://docs.test/device");
    assert_eq!(
        start["verification_uri_complete"],
        format!("http://docs.test/device?user_code={user_code}")
    );
    assert_eq!(start["interval"], 5);
    assert_eq!(start["expires_in"], 600);
    assert_eq!(user_code.len(), 9, "XXXX-XXXX: {user_code}");

    assert_eq!(
        error_of(&t.poll(&client_id, device_code).await),
        "authorization_pending"
    );

    // Opening the link signs the user in (dev login here) and comes back to the code.
    let anon = t.get(&format!("/device?user_code={user_code}"), "").await;
    assert_eq!(anon.status, StatusCode::SEE_OTHER);
    let login = url::Url::parse(&format!("http://docs.test{}", anon.location())).unwrap();
    let next = login.query_pairs().find(|(k, _)| k == "next").unwrap().1.into_owned();
    assert_eq!(next, format!("/device?user_code={user_code}"));
    let signed_in = t
        .post_form("/auth/dev", "", &[("login", "frank"), ("next", &next)])
        .await;
    assert_eq!(signed_in.status, StatusCode::SEE_OTHER, "{}", signed_in.body);
    assert_eq!(signed_in.location(), next);
    let set_cookie = signed_in.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    let cookie = set_cookie.split(';').next().unwrap().to_string();

    // A device-only client can't use the authorization code flow.
    let authorize = t
        .get(
            &format!("/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Fomarchy%3A7878%2Fcb&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"),
            &cookie,
        )
        .await;
    assert_eq!(authorize.status, StatusCode::BAD_REQUEST);

    // Typing the code in lower case without the dash works too.
    let entry = t.get("/device", &cookie).await;
    assert!(entry.body.contains("Enter the code"));
    let typed = t
        .get(
            &format!("/device?user_code={}", user_code.replace('-', "").to_lowercase()),
            &cookie,
        )
        .await;
    assert!(typed.body.contains("Connect Huntaway?"));
    assert!(typed.body.contains("it is not verified"), "{}", typed.body);
    assert!(typed.body.contains("It registered <time"), "{}", typed.body);
    let wrong = t.get("/device?user_code=BBBB-BBBB", &cookie).await;
    assert!(wrong.body.contains("That code is not valid"));

    let approved = t.decide_device(&cookie, user_code, "allow").await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.body);
    assert!(approved.body.contains("Huntaway is connected"));
    let again = t.get(&format!("/device?user_code={user_code}"), &cookie).await;
    assert!(again.body.contains("That code is not valid"), "codes are single use");

    let ok = t.poll(&client_id, device_code).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let tokens = ok.json();
    assert_eq!(tokens["token_type"], "Bearer");
    let access = tokens["access_token"].as_str().unwrap();
    let published = t
        .tool(
            access,
            "publish_document",
            json!({ "slug": "from-huntaway", "pages": [{ "path": "index.md", "content": "# Hello\n" }] }),
        )
        .await;
    assert_eq!(published["version"], 1);
    let page = t.get("/d/from-huntaway/", &cookie).await;
    assert_eq!(page.status, StatusCode::OK, "published as frank");

    assert_eq!(
        error_of(&t.poll(&client_id, device_code).await),
        "invalid_grant",
        "the device code is single use"
    );

    let refreshed = t
        .post_form(
            "/oauth/token",
            "",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.body);
}

#[tokio::test]
async fn oauth_device_flow_denial_expiry_and_slow_down() {
    let t = TestApp::new().await;
    let (cookie, _) = t.user("gina").await;
    let client_id = t.device_client().await;

    // Polling faster than the interval.
    let start = t.start_device(&client_id).await;
    let device_code = start["device_code"].as_str().unwrap();
    assert_eq!(
        error_of(&t.poll(&client_id, device_code).await),
        "authorization_pending"
    );
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "slow_down");
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "slow_down");
    let other = t.device_client().await;
    t.decide_device(&cookie, start["user_code"].as_str().unwrap(), "allow")
        .await;
    assert_eq!(
        error_of(&t.poll(&other, device_code).await),
        "invalid_grant",
        "issued to another client"
    );
    let anonymous = t
        .post_form(
            "/oauth/token",
            "",
            &[("grant_type", DEVICE_GRANT), ("device_code", device_code)],
        )
        .await;
    assert_eq!(error_of(&anonymous), "invalid_request", "client_id is required");
    let ok = t.poll(&client_id, device_code).await;
    assert_eq!(
        ok.status,
        StatusCode::OK,
        "the wrong client didn't use up the approval: {}",
        ok.body
    );

    // Denied.
    let start = t.start_device(&client_id).await;
    let device_code = start["device_code"].as_str().unwrap();
    let denied = t
        .decide_device(&cookie, start["user_code"].as_str().unwrap(), "deny")
        .await;
    assert!(denied.body.contains("Access denied"));
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "access_denied");
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "invalid_grant");

    // Expired, and still reported as expired after another client starts.
    let start = t.start_device(&client_id).await;
    let device_code = start["device_code"].as_str().unwrap();
    let expire = |ago: i64| {
        sqlx::query("UPDATE oauth_device_codes SET expires_at = ? WHERE hash = ?")
            .bind(db::now() - ago)
            .bind(db::hash_token(device_code))
            .execute(&t.state.db)
    };
    expire(60).await.unwrap();
    t.start_device(&client_id).await;
    assert_eq!(db::purge_device_codes(&t.state.db).await.unwrap(), 0);
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "expired_token");
    let late = t
        .get(
            &format!("/device?user_code={}", start["user_code"].as_str().unwrap()),
            &cookie,
        )
        .await;
    assert!(late.body.contains("That code is not valid"));
    // Long expired codes are purged.
    expire(db::DEVICE_CODE_GRACE + 1).await.unwrap();
    assert_eq!(db::purge_device_codes(&t.state.db).await.unwrap(), 1);
    assert_eq!(error_of(&t.poll(&client_id, device_code).await), "invalid_grant");

    // Approved, but the user has since been removed from DOCS_ALLOWED_USERS.
    let start = t.start_device(&client_id).await;
    t.decide_device(&cookie, start["user_code"].as_str().unwrap(), "allow")
        .await;
    let mut config = Config::for_tests();
    config.allowed_users = Some(vec!["someone-else".into()]);
    let state = AppState {
        db: t.state.db.clone(),
        config: std::sync::Arc::new(config),
        http: t.state.http.clone(),
    };
    let t = TestApp {
        app: docs::app(state.clone()),
        state,
    };
    assert_eq!(
        error_of(&t.poll(&client_id, start["device_code"].as_str().unwrap()).await),
        "invalid_grant"
    );

    // Unknown clients and registrations that can't do anything.
    let unknown = t
        .post_form("/oauth/device_authorization", "", &[("client_id", "client_nope")])
        .await;
    assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown.json()["error"], "invalid_client");
    let useless = t
        .send(
            Request::post("/oauth/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "grant_types": ["refresh_token"] }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(useless.status, StatusCode::BAD_REQUEST);
    assert_eq!(useless.json()["error"], "invalid_client_metadata");
}

#[tokio::test]
async fn oauth_clients_only_use_the_grants_they_registered() {
    let t = TestApp::new().await;
    let (cookie, _) = t.user("hana").await;
    let code_only = t
        .send(
            Request::post("/oauth/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "client_name": "Web Agent", "redirect_uris": ["http://localhost:4444/cb"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .json();
    assert_eq!(code_only["grant_types"], json!(["authorization_code", "refresh_token"]));
    let code_only = code_only["client_id"].as_str().unwrap();
    let res = t
        .post_form("/oauth/device_authorization", "", &[("client_id", code_only)])
        .await;
    assert_eq!(error_of(&res), "unauthorized_client");

    // A device-only client is turned away from /oauth/authorize, even with a redirect URI.
    let reg = t
        .send(
            Request::post("/oauth/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "grant_types": [DEVICE_GRANT], "redirect_uris": ["http://localhost:4444/cb"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .json();
    assert_eq!(reg["grant_types"], json!([DEVICE_GRANT, "refresh_token"]));
    let authorize = t
        .get(
            &format!(
                "/oauth/authorize?response_type=code&client_id={}&redirect_uri=http%3A%2F%2Flocalhost%3A4444%2Fcb&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256",
                reg["client_id"].as_str().unwrap()
            ),
            &cookie,
        )
        .await;
    assert_eq!(authorize.status, StatusCode::BAD_REQUEST);
    assert!(
        authorize
            .body
            .contains("did not register for the authorization code grant")
    );
}

#[tokio::test]
async fn pending_device_authorizations_are_capped() {
    let t = TestApp::new().await;
    let client_id = t.device_client().await;
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO oauth_device_codes (hash, user_code, client_id, interval, expires_at)
         SELECT 'h' || i, 'U' || i, ?, 5, ? FROM n",
    )
    .bind(db::MAX_PENDING_DEVICE_CODES)
    .bind(&client_id)
    .bind(db::now() + 600)
    .execute(&t.state.db)
    .await
    .unwrap();
    let full = t
        .post_form("/oauth/device_authorization", "", &[("client_id", &client_id)])
        .await;
    assert_eq!(full.status, StatusCode::SERVICE_UNAVAILABLE, "{}", full.body);
    assert_eq!(full.json()["error"], "temporarily_unavailable");

    // Expired ones don't count.
    sqlx::query("UPDATE oauth_device_codes SET expires_at = 0 WHERE hash = 'h1'")
        .execute(&t.state.db)
        .await
        .unwrap();
    t.start_device(&client_id).await;
}
