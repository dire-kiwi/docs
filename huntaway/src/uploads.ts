import { ByteSize, Effect, Option } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import type { PluginRoute } from "@huntaway/plugin"
import type { Docs } from "./docs.ts"
import type { RenderLib } from "./render.ts"

// Where agents send image files (DOC-22): `POST` (or `PUT`, as `curl -T` does) `/plugins/docs/uploads/<token>` with the
// file as the body, to the URL `create_upload_url` gave. The route is public, as an agent's shell has no board token:
// the random token in the URL says whose upload it is, and nothing of a request is read without one that still lasts.
// It answers JSON, `{ id, bytes, expires_in }` or `{ error }`, as the hosted site's `/api/uploads/<token>` does.

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status })

export const uploadRoutes = (docs: Docs, lib: RenderLib): ReadonlyArray<PluginRoute> => {
  const max = lib.imageLimits().maxUploadBytes
  const errors = lib.uploadErrors()
  const upload = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const profile = yield* docs.uploader((yield* HttpRouter.params)["token"] ?? "")
    if ((request.headers["content-type"] ?? "").trim().toLowerCase().startsWith("multipart/")) return json(400, { error: errors.body })
    // Read with the upload's own limit, not the board's for its other requests.
    const body = yield* Effect.option(Effect.provideService(request.arrayBuffer, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(max)))
    if (Option.isNone(body)) return json(413, { error: errors.tooBig })
    return json(200, yield* docs.upload(profile, new Uint8Array(body.value)))
  })
  const handle = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.catchTag(upload(request), "UploadRefused", (e) => Effect.succeed(json(e.status, { error: e.message })))
  return (["POST", "PUT"] as const).map((method): PluginRoute => ({ method, path: "/uploads/:token", auth: "public", handle }))
}
