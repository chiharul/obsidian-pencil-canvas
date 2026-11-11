// Build: `npm install` then `npm run build` (writes main.js next to manifest.json).
const esbuild = require("esbuild");
const path = require("path");

esbuild
  .build({
    entryPoints: [path.join(__dirname, "src", "main.ts")],
    outfile: path.join(__dirname, "main.js"),
    bundle: true,
    format: "cjs",
    target: "es2018",
    platform: "browser",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
    logLevel: "info",
    minify: process.argv.includes("--minify"),
  })
  .catch(() => process.exit(1));
