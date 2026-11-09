import esbuild from "esbuild";
import { builtinModules } from "node:module";

const diagnostic = process.argv[2] === "diagnostic";
const production = process.argv[2] === "production" || diagnostic;

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  define: { __CLINGNOTE_TRACE_FILE__: JSON.stringify("") }, // diagnostic tracing is a developer-only feature and is disabled in public builds
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
