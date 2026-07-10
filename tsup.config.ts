import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    api: "src/api.ts",
    cli: "src/cli.ts",
    tui: "src/tui.ts",
  },
  format: ["esm"],
  clean: true,
  dts: true,
  outDir: "dist",
  minify: false,
  external: [
    "@opencode-ai/plugin",
    "fs",
    "path",
    "os",
    "child_process",
    "node:fs",
    "node:path",
    "node:os",
    "node:child_process",
  ],
});
