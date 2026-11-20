import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { ImageUpload } from "@dire-kiwi/docs-render"
import type { NewImage } from "./repo.ts"
import type { RenderLib } from "./render.ts"

// Converting a publish's images to AVIF, as the hosted site does (DOC-12): the renderer's `validatePublish` has
// recognised them already (names, base64, PNG/JPEG/WebP/GIF/AVIF, at most 200); each is converted here with `sharp`
// (libvips, a native module, on libuv's threads, so the board isn't held up) and refused if that is over 500 KB: it
// isn't resized to fit. Only the AVIF is kept, not what was uploaded. An AVIF is kept as it came once sharp has read it,
// as the hosted site does.

/** AVIF encoding (sharp's `avif()`): quality 1-100, and effort 0 (fastest) to 9 (smallest). */
export const AVIF_QUALITY = 60
export const AVIF_EFFORT = 2
/** The most pixels an image may have to be decoded at all (about 100 megapixels), so a small file can't expand to gigabytes. */
export const MAX_INPUT_PIXELS = 100_000_000

/** Why an image isn't taken, in the hosted site's words. */
export class ImageRefused extends Schema.TaggedError<ImageRefused>()("ImageRefused", { message: Schema.String }) {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const sharp = Effect.cached(Effect.promise(() => import("sharp").then((m) => m.default)))

export const makeImages = Effect.gen(function* () {
  const load = yield* sharp

  const sha256 = (bytes: Uint8Array) => Effect.sync(() => createHash("sha256").update(bytes).digest("hex"))

  const toAvif = Effect.fnUntraced(function* (lib: RenderLib, im: Omit<ImageUpload, "data">, bytes: Uint8Array) {
    const convert = yield* load
    const unreadable = (e: unknown) => new ImageRefused({ message: lib.imageUnreadableError(im.label, message(e)) })
    const out =
      im.format === "avif"
        ? // Already AVIF: kept as it is, once it's read as one.
          yield* Effect.tryPromise({ try: () => convert(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(), catch: unreadable }).pipe(
            Effect.flatMap((m) =>
              m.format !== "heif" || m.compression !== "av1" || !m.width || !m.height
                ? Effect.fail(unreadable(new Error("not an AVIF image")))
                : Effect.succeed({ data: bytes, width: m.width, height: m.height }),
            ),
          )
        : // An animation's first frame (`animated: false`), turned as its EXIF says (`rotate()`), without its metadata.
          yield* Effect.tryPromise({
            try: () =>
              convert(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
                .rotate()
                .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
                .toBuffer({ resolveWithObject: true }),
            catch: unreadable,
          }).pipe(Effect.map((r) => ({ data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length), width: r.info.width, height: r.info.height })))
    if (out.data.length > lib.imageLimits().maxImageBytes) return yield* new ImageRefused({ message: lib.imageTooLargeError(im.label, out.data.length) })
    const image: NewImage = { name: im.name, sha256: yield* sha256(out.data), data: out.data, width: out.width, height: out.height }
    return image
  })

  return {
    /** Each image converted, one at a time (each takes all of libvips' threads). */
    convert: (lib: RenderLib, images: ReadonlyArray<ImageUpload>) =>
      Effect.forEach(images, (im) => Effect.flatMap(Effect.orDie(Effect.fromResult(Base64.decode(im.data))), (bytes) => toAvif(lib, im, bytes)), { concurrency: 1 }),
    /** One image converted from its bytes (a file uploaded on its own). */
    convertBytes: toAvif,
  }
})

export type Images = Effect.Success<typeof makeImages>
