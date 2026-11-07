// Node entry: loads the WebAssembly synchronously, so every export works
// straight after `import`. `await init()` is still accepted (it does nothing),
// so code shared with the browser can call it unconditionally.
import { readFileSync } from "node:fs";
import { initSync } from "./docs_render.js";

initSync({ module: readFileSync(new URL("./docs_render_bg.wasm", import.meta.url)) });

export * from "./docs_render.js";
export { default } from "./docs_render.js";
