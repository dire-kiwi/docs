#!/usr/bin/env bash
# Install the packed @dire-kiwi/docs-render (run build.sh first) into a scratch
# project and check it against the native renderer's output for test/fixtures.
set -euo pipefail
cd "$(dirname "$0")/../.."
crate=$PWD/crates/docs-render-wasm
tgz=$(ls "$PWD"/target/npm/dire-kiwi-docs-render-*.tgz)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cargo run -q -p docs-render-wasm --example native > "$work/native.json"
cd "$work"
echo '{ "name": "docs-render-test", "private": true, "type": "module" }' > package.json
npm install --silent --no-audit --no-fund "$tgz" typescript
cp "$crate/test/package.test.mjs" "$crate/test/types.ts" .
npx tsc --noEmit --strict --module nodenext --target es2022 --lib es2022,dom types.ts
NATIVE_JSON="$work/native.json" FIXTURES="$crate/test/fixtures" node --test package.test.mjs
