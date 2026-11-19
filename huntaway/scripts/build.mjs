// Builds the plugin into dist/: the page script bundled for the frame (dist/client.js, read when the plugin starts),
// and, without --client, the server code compiled to JavaScript with its types (the board runs it from node_modules,
// where Node doesn't strip types).
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const clientOnly = process.argv.includes("--client")

if (!clientOnly) rmSync(join(root, "dist"), { recursive: true, force: true })
await build({
  entryPoints: [join(root, "client/page.ts")],
  outfile: join(root, "dist/client.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  // The editor's styles (frontend/src/editor.css), which the script adds to its page.
  loader: { ".css": "text" },
  logLevel: "warning",
})
if (!clientOnly) execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.build.json")], { stdio: "inherit" })
