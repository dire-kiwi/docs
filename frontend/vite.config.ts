import { defineConfig } from "vite-plus";

// The Rust server renders every page and links the built assets through
// dist/.vite/manifest.json; in development it can load them from `vp dev` instead
// (set DOCS_VITE_DEV_URL=http://localhost:5173 for the server).
export default defineConfig({
  base: "/static/",
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    origin: "http://localhost:5173",
  },
  build: {
    manifest: true,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.ts",
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
