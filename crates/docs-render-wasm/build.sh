#!/usr/bin/env bash
# Build the @dire-kiwi/docs-render npm package into target/npm/docs-render and
# pack it as target/npm/dire-kiwi-docs-render-<version>.tgz.
#
# Needs: the wasm32-unknown-unknown target, wasm-bindgen-cli at the version in
# Cargo.lock, and Node.js (for npm pack).
set -euo pipefail
cd "$(dirname "$0")/../.."
crate=crates/docs-render-wasm
out=target/npm/docs-render

version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$crate/Cargo.toml" | head -1)
need=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ "$need" != "$have" ]; then
  echo "wasm-bindgen-cli ${have:-missing}, Cargo.lock has $need: cargo install wasm-bindgen-cli --version $need --locked" >&2
  exit 1
fi

cargo build -p docs-render-wasm --target wasm32-unknown-unknown --profile wasm
rm -rf "$out"
mkdir -p "$out"
wasm-bindgen --target web --out-dir "$out" --out-name docs_render \
  target/wasm32-unknown-unknown/wasm/docs_render_wasm.wasm

# wasm-bindgen drops the `?` from Option parameters that have an explicit TypeScript type.
dts="$out/docs_render.d.ts"
sed -i -e 's/options: RenderOptions | null)/options?: RenderOptions | null)/' \
  -e 's/format: Format | null, path: string | null)/format?: Format | null, path?: string | null)/' \
  -e 's/content: string, format: Format, path: string | null)/content: string, format: Format, path?: string | null)/' "$dts"
grep -q 'options?: RenderOptions' "$dts" && grep -q 'format?: Format | null, path?: string | null)' "$dts" \
  && grep -q 'format: Format, path?: string | null)' "$dts" || {
  echo "build.sh: could not mark the optional parameters in $dts" >&2
  exit 1
}

cp "$crate/npm/node.js" "$crate/README.md" LICENSE "$out/"
sed "s/\"version\": \"0.0.0\"/\"version\": \"$version\"/" "$crate/npm/package.json" > "$out/package.json"

# The reader styles, scoped so they only apply inside an element with class docs-render.
{
  echo "/* @dire-kiwi/docs-render $version: styles for rendered pages. Put rendered HTML inside"
  echo "   <div class=\"docs-render\"><div class=\"doc-content\">…</div></div>. Override the --variables"
  echo "   on .docs-render to match your theme. */"
  echo "@scope (.docs-render) {"
  echo ":scope {"
  echo "  background: var(--bg);"
  echo "  color: var(--fg);"
  echo "  font: 16px/1.6 var(--font);"
  echo "}"
  echo
  sed -e 's/^\( *\):root {/\1:scope {/' frontend/src/reader.css
  echo "}"
} > "$out/styles.css"

rm -f target/npm/dire-kiwi-docs-render-*.tgz
(cd "$out" && npm pack --silent --pack-destination ..)
ls -l target/npm/*.tgz
