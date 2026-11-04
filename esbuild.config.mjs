// Builds the plugin into dist/: main.js and manifest.json are what a vault's `.obsidian/plugins/fold-memory/` holds.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** What Obsidian itself provides, so it is never bundled. */
export const EXTERNAL = ["obsidian", "electron", "@codemirror/*", "@lezer/*"];

export const OPTIONS = {
	entryPoints: [join(here, "src/main.ts")],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	external: EXTERNAL,
	logLevel: "warning",
	legalComments: "none",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	mkdirSync(join(here, "dist"), { recursive: true });
	await build({ ...OPTIONS, outfile: join(here, "dist/main.js") });
	copyFileSync(join(here, "manifest.json"), join(here, "dist/manifest.json"));
}
