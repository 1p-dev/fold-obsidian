import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildOptions, build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL, OPTIONS } from "../esbuild.config.mjs";

const here = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(here, "../manifest.json"), "utf8")) as Record<string, unknown>;
const pack = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as Record<string, unknown>;
/** Every source file that ends up in the plugin. */
const shipped = readdirSync(here)
	.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-support.ts")
	.map((name) => readFileSync(join(here, name), "utf8"))
	.join("\n");

describe("the plugin as Obsidian loads it", () => {
	let code = "";

	beforeAll(async () => {
		const built = await build({ ...(OPTIONS as BuildOptions), write: false });
		code = built.outputFiles?.[0]?.text ?? "";
	});

	it("needs nothing from Node, so it can run on a phone", () => {
		const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
		expect(new Set(required)).toEqual(new Set(["obsidian"]));
		expect(EXTERNAL).toContain("obsidian");
	});

	it("holds no lookbehind, which older phones cannot parse", () => {
		expect(code).not.toMatch(/\(\?<[=!]/);
	});

	it("takes none of the web app's interface with it", () => {
		expect(code).not.toContain("react");
		expect(code.length).toBeLessThan(60_000);
	});

	it("never logs, so nothing from a note or a token reaches a console", () => {
		expect(code).not.toMatch(/console\.(log|info|debug|warn|error)/);
	});

	it("calls no write route, in any file that ships", () => {
		for (const write of ["writeFile", "deleteFile", "saveNote", "createSpace"]) expect(shipped, write).not.toContain(write);
	});

	it("reads the token only from Obsidian's secret storage", () => {
		expect(shipped).toContain("secretStorage.getSecret");
		expect(shipped).not.toContain("setSecret");
	});
});

describe("the manifest", () => {
	it("is what the directory's rules ask of an id, and is versioned with the package", () => {
		expect(manifest.id).toBe("fold-memory");
		expect(String(manifest.id)).not.toContain("obsidian");
		expect(manifest.version).toBe(pack.version);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("asks for the Obsidian that has declarative settings, the oldest public 1.13, which also has secret storage", () => {
		expect(manifest.minAppVersion).toBe("1.13.4");
	});
});
