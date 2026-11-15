import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { withHarness } from "./harness.ts"
import type { SiteRequest } from "./harness.ts"

// Publishing to a hosted docs site, against a pretend one: the device sign-in (RFC 8628), a pasted token, and
// publishing a version through the site's MCP `publish_document`, remembering where it went.

const SITE = "https://docs.example"
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

/** A pretend site: OAuth metadata, registration, the device flow (approved on the second poll), and /mcp. */
const site = (state: { polls: number; published: Array<any>; existing?: Record<string, unknown> }) => (r: SiteRequest) => {
  const path = new URL(r.url).pathname
  if (path === "/.well-known/oauth-authorization-server")
    return json({ token_endpoint: `${SITE}/oauth/token`, registration_endpoint: `${SITE}/oauth/register`, device_authorization_endpoint: `${SITE}/oauth/device_authorization` })
  if (path === "/oauth/register") return json({ client_id: "client-1" }, 201)
  if (path === "/oauth/device_authorization")
    return json({ device_code: "dev-secret", user_code: "BCDF-GHJK", verification_uri: `${SITE}/device`, verification_uri_complete: `${SITE}/device?code=BCDF-GHJK`, expires_in: 600, interval: 0.01 })
  if (path === "/oauth/token") {
    state.polls++
    return state.polls < 2 ? json({ error: "authorization_pending" }, 400) : json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
  }
  if (path === "/mcp") {
    if (r.headers["authorization"] !== "Bearer access-1" && r.headers["authorization"] !== "Bearer pat-1") return json({ error: "invalid_token" }, 401)
    const body = JSON.parse(r.body)
    const { name, arguments: args } = body.params
    const result = (v: unknown) => json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v } })
    if (name === "list_documents") return result({ documents: [{ slug: "mine", owner: "ivan", shared_with_you: false }] })
    if (name === "get_document") {
      if (state.existing && args.slug === state.existing["slug"]) return result(state.existing)
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `no document "${args.slug}"` }], isError: true } })
    }
    if (name === "publish_document") {
      state.published.push(args)
      return result({ slug: args.slug, version: state.published.length, url: `${SITE}/d/${args.slug}/`, version_url: `${SITE}/d/${args.slug}/-/v/${state.published.length}/`, warnings: [] })
    }
  }
  return new Response("not found", { status: 404 })
}

const waitFor = <A>(check: Effect.Effect<A>, ok: (a: A) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const v = yield* check
      if (ok(v)) return v
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error("timed out"))
  })

describe("hosted docs", () => {
  it.live("connects with the device sign-in and publishes a version, with its folder, labels and images, then again to the same document", () => {
    const state = { polls: 0, published: [] as Array<any> }
    return withHarness({ site: site(state) }, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", { title: "Plan", labels: ["plans"], pages: [{ path: "index", content: "# Plan" }] })
        const started = yield* h.call("site.start", { profile: "p1", site: "docs.example/" })
        assert.strictEqual(started.site_url, SITE)
        assert.strictEqual(started.pending.user_code, "BCDF-GHJK")
        // The page shows the code and the link; never the device code.
        const pending = yield* h.page("p1")
        assert.include(pending.html, "BCDF-GHJK")
        assert.notInclude(pending.html, "dev-secret")
        const connected = yield* waitFor(h.call("site.status", { profile: "p1" }).pipe(Effect.orDie), (s) => s.connected === true && s.login !== null)
        assert.deepStrictEqual([connected.kind, connected.login], ["oauth", "ivan"])
        // The registration names this host.
        assert.include(h.requests.find((r) => r.url.endsWith("/oauth/register"))?.body ?? "", "Huntaway (testhost)")
        const home = yield* h.page("p1")
        assert.include(home.html, "Publishing to <a href=\"https://docs.example\">docs.example</a> as <b>ivan</b>")
        assert.notInclude(home.html, "access-1")

        const first = yield* h.call("site.publish", { profile: "p1", slug: "plan", version: 1, remote_slug: "plan" })
        assert.strictEqual(first.published.remote_slug, "plan")
        assert.strictEqual(first.published.url, `${SITE}/d/plan/`)
        assert.deepStrictEqual(state.published[0], { slug: "plan", title: "Plan", pages: [{ path: "index", title: "Plan", format: "md", content: "# Plan" }], mode: "replace", folder: "Docs", labels: ["plans"] })
        const doc = yield* h.page("p1/d/plan/")
        assert.include(doc.html, "On docs.example (v1, from v1)")

        yield* h.ok("publish_document", { slug: "plan", pages: [{ path: "index", content: "# Plan 2" }] })
        const second = yield* h.call("site.publish", { profile: "p1", slug: "plan", version: 2, remote_slug: "plan" })
        assert.strictEqual(second.published.remote_version, 2)
        // Later publishes don't move or relabel it there.
        assert.notProperty(state.published[1], "folder")
        assert.notProperty(state.published[1], "labels")

        const off = yield* h.call("site.disconnect", { profile: "p1" })
        assert.strictEqual(off.connected, false)
        assert.strictEqual(off.site_url, SITE)
      }),
    )
  })

  it.live("asks before publishing to a document the user has at that slug already, and refuses a bad token", () => {
    const state = { polls: 0, published: [] as Array<any>, existing: { slug: "plan", title: "Their plan", latest_version: 3, owner: "ivan", url: `${SITE}/d/plan/`, sharing: {} } }
    return withHarness({ site: site(state) }, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", { title: "Plan", pages: [{ path: "index", content: "# Plan" }] })
        const bad = yield* Effect.flip(h.call("site.token", { profile: "p1", site: SITE, token: "nope" }))
        assert.strictEqual(bad.message, "docs.example doesn't take that token (it may have been revoked or have expired)")
        const ok = yield* h.call("site.token", { profile: "p1", site: SITE, token: "pat-1" })
        assert.deepStrictEqual([ok.connected, ok.kind, ok.login], [true, "token", "ivan"])
        const asked = yield* h.call("site.publish", { profile: "p1", slug: "plan", version: 1, remote_slug: "plan" })
        assert.deepStrictEqual(asked.exists, { slug: "plan", title: "Their plan", latest_version: 3, url: `${SITE}/d/plan/`, owner: "ivan" })
        assert.strictEqual(state.published.length, 0)
        const done = yield* h.call("site.publish", { profile: "p1", slug: "plan", version: 1, remote_slug: "plan", confirmed: true })
        assert.strictEqual(done.published.remote_slug, "plan")
        const unconnected = yield* Effect.flip(h.call("site.publish", { profile: "p9", slug: "plan", version: 1, remote_slug: "plan" }))
        assert.strictEqual(unconnected.reason, "not_found")
      }),
    )
  })
})
