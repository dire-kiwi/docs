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
// The design editor's side of a mockup's frame (frontend/src/design/agent.ts), as source: the page script puts it in
// each frame it makes (a frame in the board's sandboxed frame is out of the page's reach, so it runs its own script).
const agent = await build({
  entryPoints: [join(root, "../frontend/src/design/agent.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
})
await build({
  entryPoints: [join(root, "client/page.ts")],
  outfile: join(root, "dist/client.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  // The editors' styles (frontend/src/editor.css and design/design.css), which the script adds to its page.
  loader: { ".css": "text" },
  define: { DESIGN_AGENT: JSON.stringify(agent.outputFiles[0].text) },
  logLevel: "warning",
})
if (!clientOnly) execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.build.json")], { stdio: "inherit" })
