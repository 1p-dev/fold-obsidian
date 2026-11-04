// The plugin in real Obsidian, offscreen, against the API mock over local https, driven through the debugging port. The unit tests stop at the plugin's own seams; this is what proves it against Obsidian's real vault, secret storage, requestUrl and link index. It is run by hand, since it needs Obsidian itself and xvfb-run, never by the pre-push hook.
// Usage, from extensions/obsidian: pnpm build, then node e2e/run.mjs <obsidian_binary> [work_dir]
// To get Obsidian on Linux: download the AppImage from github.com/obsidianmd/obsidian-releases, run it with --appimage-extract, and pass squashfs-root/obsidian.
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const binary = process.argv[2];
const work = process.argv[3] ?? mkdtempSync(join(tmpdir(), "fold-obsidian-e2e-"));
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist");
const mockPath = join(work, "mock.mjs");
mkdirSync(work, { recursive: true });
await build({ entryPoints: [join(here, "../src/api/mock.ts")], bundle: true, platform: "node", format: "esm", outfile: mockPath, logLevel: "warning" });
const { createMockApi } = await import(pathToFileURL(mockPath).href);
const notesPath = join(work, "notes.mjs");
await build({ entryPoints: [join(here, "../src/notes.ts")], bundle: true, platform: "node", format: "esm", outfile: notesPath, logLevel: "warning" });
const { asOpened, localForm } = await import(pathToFileURL(notesPath).href);
const PORT = 8443;
const CDP = 9333;
const EVIL_PORT = 8444;
const TOKEN = "e2e-not-a-real-token"; // secret-scan-ok: a stand-in the test server checks for
const vault = join(work, "vault");
const home = join(work, "home");
const results = [];
const check = (name, ok, extra = "") => {
	results.push(ok);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `: ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

rmSync(vault, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
const pluginDir = join(vault, ".obsidian/plugins/fold-memory");
mkdirSync(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json"]) copyFileSync(join(dist, file), join(pluginDir, file));
writeFileSync(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["fold-memory"]));
// As a vault someone else prepared would: its saved data names their server, the person's secret and a space the person never chose. Only what is set on this device may count.
writeFileSync(join(pluginDir, "data.json"), JSON.stringify({ queryUrl: `https://127.0.0.1:${EVIL_PORT}`, secretName: "fold-token", space: "another", intervalMinutes: 60 }));
mkdirSync(join(vault, "inbox"), { recursive: true });
writeFileSync(join(vault, "inbox/my-own.md"), "A person's own note, which Fold knows nothing about.\n");
const config = join(home, ".config/obsidian");
mkdirSync(config, { recursive: true });
const profile = join(work, "profile");
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
for (const folder of [config, profile]) writeFileSync(join(folder, "obsidian.json"), JSON.stringify({ vaults: { e2evault00000000: { path: vault, ts: Date.now(), open: true } } }));

const WINDOWS = "\ufeff# Written on Windows\r\n\r\ncaf\u00e9, cafe\u0301, \u{1f339}\rlone return\r\n\r\nNo final newline";
const SEED = {
	"PURPOSE.md": "# Garden\n",
	"OVERVIEW.md": "Notes on the garden.\n",
	"SAVING.md": "Save what worked.\n",
	"inbox/windows.md": WINDOWS,
	"managed/roses.md": "---\ntags:\n  - roses\n---\n# Roses\n\nFeed them on [[soil]], and see [[soil#Clay|the clay]].\n\n> [!tip] Before you prune\n> Wait for late winter.\n",
	"managed/deep/soil.md": "# Soil\n\n## Clay\n\nHeavy clay suits [[roses]].\n",
	"managed/goes-away.md": "# This note will be removed\n",
	"inbox/non\u00a0breaking.md": "# A name with a non-breaking space\n",
	"managed/cafe\u0301.md": "# A name with its accent written apart\n",
	"reference/handbook.md": "# Handbook, which a vault never holds\n",
	"inbox/.obsidian/evil.md": "# A note named to reach the vault's settings\n",
	"inbox/a:b.md": "# A name Windows cannot hold\n",
	"inbox/my-own.md": "# Fold's note of the same name as a person's own\n",
};
const api = createMockApi({
	spaces: [
		{ id: "garden", organization: { id: "o", name: "O" }, access: "admin", files: SEED },
		{ id: "another", organization: { id: "o", name: "O" }, access: "admin", files: { "PURPOSE.md": "# Another\n", "inbox/windows.md": "# Another space's note\n", "inbox/only-there.md": "# Only there\n" } },
	],
});

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
const requests = [];
const tls = { key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) };
// Stands for a host a token must never reach, whether named by planted settings or a redirect.
const evilRequests = [];
const evilServer = createServer(tls, (req, res) => {
	evilRequests.push({ path: req.url, auth: req.headers.authorization });
	res.writeHead(200, { "content-type": "application/json" });
	res.end("{}");
});
await new Promise((resolve) => evilServer.listen(EVIL_PORT, "127.0.0.1", resolve));
const server = createServer(tls, async (req, res) => {
	const url = `https://localhost:${PORT}${req.url}`;
	if (req.url === "/redirect-probe") {
		res.writeHead(302, { location: `https://127.0.0.1:${EVIL_PORT}/landed` });
		res.end();
		return;
	}
	requests.push({ method: req.method, path: decodeURIComponent(new URL(url).pathname), auth: req.headers.authorization });
	const answer = await api.handle(new Request(url, { method: req.method, headers: { authorization: req.headers.authorization ?? "" } }));
	res.writeHead(answer.status, Object.fromEntries(answer.headers));
	res.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const change = async (method, path, body) => {
	const answer = await api.handle(new Request(`https://localhost:${PORT}/v1/spaces/garden/files/${path}`, { method, headers: { authorization: "Bearer t" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
	if (answer.status >= 400) throw new Error(`${method} ${path}: ${answer.status} ${await answer.text()}`);
	api.finishIndexing();
};

const app = spawn("xvfb-run", ["-a", binary, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${CDP}`, "--ignore-certificate-errors", `--user-data-dir=${join(work, "profile")}`], {
	env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), DISPLAY: "" },
	stdio: "ignore",
	detached: true,
});

let socket;
let nextId = 1;
const pending = new Map();
const consoleProblems = [];
function connect(url) {
	return new Promise((resolve, reject) => {
		socket = new WebSocket(url);
		socket.onopen = resolve;
		socket.onerror = reject;
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id && pending.has(message.id)) {
				pending.get(message.id)(message);
				pending.delete(message.id);
			} else if (message.method === "Runtime.exceptionThrown") {
				consoleProblems.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
			} else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
				consoleProblems.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
			}
		};
	});
}
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
async function run(expression) {
	const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (answer.result?.exceptionDetails) throw new Error(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text);
	return answer.result?.result?.value;
}
async function until(what, condition, ms = 45_000) {
	const end = Date.now() + ms;
	for (;;) {
		try {
			const value = await condition();
			if (value) return value;
		} catch {}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(400);
	}
}
const screenshot = async (name) => {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(work, `${name}.png`), Buffer.from(shot.result.data, "base64"));
};
const vaultFiles = () => run(`app.vault.getFiles().map((f) => f.path).sort()`);
const syncNow = async () => {
	const before = requests.length;
	await run(`app.commands.executeCommandById("fold-memory:sync-now")`);
	await until("the sync to finish", () => run(`!app.plugins.plugins["fold-memory"].running`));
	return requests.slice(before);
};

try {
	const page = await until("Obsidian's window", async () => {
		const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
		return targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
	}, 60_000);
	await connect(page.webSocketDebuggerUrl);
	await send("Runtime.enable");
	await send("Page.enable");
	await until("the app and the vault", () => run(`typeof app !== "undefined" && !!app.workspace.layoutReady`), 60_000);
	console.log("Obsidian version:", await run(`require("electron").ipcRenderer.sendSync("version") || "unknown"`).catch(() => "unknown"));

	await run(`document.querySelector(".modal-close-button")?.click()`);
	await run(`app.secretStorage.setSecret("fold-token", ${JSON.stringify(TOKEN)})`);
	await run(`app.saveLocalStorage("fold-memory-connection", null)`);
	await run(`(async () => { await app.plugins.setEnable(true); await app.plugins.loadManifests(); await app.plugins.enablePlugin("fold-memory"); })()`);
	await until("the plugin to load", () => run(`!!app.plugins.plugins["fold-memory"]`));
	check("the plugin loads in real Obsidian", true);
	await run(`app.plugins.plugins["fold-memory"].syncNow(true)`);
	await sleep(1500);
	check("a vault's planted settings send the token nowhere: no address on this device, no call", evilRequests.length === 0 && requests.length === 0, `${evilRequests.length} to the planted host, ${requests.length} to Fold`);
	await run(`(() => { const plugin = app.plugins.plugins["fold-memory"]; plugin.connection.queryUrl = "https://localhost:${PORT}"; plugin.connection.secretName = "fold-token"; plugin.connection.space = "garden"; plugin.saveConnection(); })()`);
	check("the address is kept on this device", (await run(`app.loadLocalStorage("fold-memory-connection")?.queryUrl`)) === `https://localhost:${PORT}`);
	await sleep(500);
	await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent.includes("Trust author"))?.click()`);
	await sleep(500);
	await until("the plugin after trusting the vault", () => run(`!!app.plugins.plugins["fold-memory"]`));

	const first = await syncNow();
	await until("the notes", async () => (await vaultFiles()).includes("managed/roses.md"));
	const files = await vaultFiles();
	check("only the notes came, and the person's own file is still there", JSON.stringify(files) === JSON.stringify(["inbox/my-own.md", "inbox/non breaking.md", "inbox/windows.md", "managed/caf\u00e9.md", "managed/deep/soil.md", "managed/goes-away.md", "managed/roses.md"]), files.join(", "));
	check("the space the vault's saved data named was never asked for", !requests.some((r) => r.path.includes("/another")));
	check("nothing from reference, guidance or hostile paths came", !existsSync(join(vault, "reference")) && !existsSync(join(vault, "PURPOSE.md")) && !existsSync(join(vault, "inbox/.obsidian")));
	check("the plugin never asked for a hostile or non-note file", !first.some((r) => /content\/(reference|PURPOSE|OVERVIEW|inbox\/\.obsidian|inbox\/a:b)/.test(r.path)), first.map((r) => r.path.replace("/v1/spaces/garden", "")).join(" "));
	check("the person's own file was not overwritten", readFileSync(join(vault, "inbox/my-own.md"), "utf8").startsWith("A person's own note"));
	check("on disk the note is byte for byte: byte order mark, CRLF, no final newline", readFileSync(join(vault, "inbox/windows.md")).equals(Buffer.from(WINDOWS, "utf8")));
	check("every request carried the token, and only as a bearer", first.every((r) => r.auth === `Bearer ${TOKEN}`));
	check("every request only read", first.every((r) => r.method === "GET"));
	const stored = readFileSync(join(pluginDir, "data.json"), "utf8");
	const savedData = JSON.parse(stored);
	check("nothing about the token is in the vault: not it, its name, the address, nor the space", !stored.includes(TOKEN) && savedData.secretName === undefined && savedData.queryUrl === undefined && savedData.space === undefined, Object.keys(savedData).join(","));
	check("the planted host still got nothing", evilRequests.length === 0);
	const onDisk = (path) => existsSync(join(vault, localForm(path)));
	check("our rule for a path on disk matches what real Obsidian wrote", ["inbox/non\u00a0breaking.md", "managed/cafe\u0301.md"].every(onDisk) && !existsSync(join(vault, "inbox/non\u00a0breaking.md")));
	check("the saved state tracks the notes", JSON.parse(stored).sync.revision === "1" && Object.keys(JSON.parse(stored).sync.files).length === 6, JSON.parse(stored).sync.revision);

	await until("Obsidian's index", () => run(`!!app.metadataCache.getCache("managed/roses.md")`));
	check("a bare wikilink finds the note in another folder", (await run(`app.metadataCache.getFirstLinkpathDest("soil", "managed/roses.md")?.path`)) === "managed/deep/soil.md");
	await until("the links", () => run(`!!app.metadataCache.resolvedLinks["managed/roses.md"]?.["managed/deep/soil.md"]`));
	check("Obsidian's link graph holds the links both ways", await run(`!!app.metadataCache.resolvedLinks["managed/deep/soil.md"]?.["managed/roses.md"]`));
	check("frontmatter reads as properties", (await run(`app.metadataCache.getCache("managed/roses.md").frontmatter?.tags?.[0]`)) === "roses");

	await run(`app.workspace.openLinkText("managed/roses.md", "", false)`);
	await until("the note to open for reading", () => run(`app.workspace.getLeaf(false).view?.getMode?.() === "preview"`), 15_000);
	check("a copied note opens for reading", true);
	await run(`app.workspace.openLinkText("inbox/my-own.md", "", true)`);
	await sleep(800);
	check("the person's own note opens as they keep it, for editing", (await run(`app.workspace.activeLeaf?.view?.file?.path`)) === "inbox/my-own.md" && (await run(`app.workspace.activeLeaf?.view?.getMode?.()`)) === "source", await run(`app.workspace.activeLeaf?.view?.getMode?.()`));
	await run(`app.workspace.openLinkText("managed/deep/soil.md", "", false)`);
	await sleep(800);
	check("a copied note reached from that same tab also opens for reading", (await run(`app.workspace.activeLeaf?.view?.getMode?.()`)) === "preview", await run(`app.workspace.activeLeaf?.view?.getMode?.()`));
	await run(`app.workspace.openLinkText("managed/roses.md", "", false)`);
	await sleep(800);
	await screenshot("note");
	check("the status bar counts the notes", (await run(`document.querySelector(".plugin-fold-memory")?.textContent`)) === "Fold: 6 notes", await run(`document.querySelector(".plugin-fold-memory")?.textContent`));

	await run(`app.workspace.openLinkText("inbox/windows.md", "", true)`);
	await sleep(2800);
	await run(`app.workspace.activeLeaf.detach()`);
	await sleep(2800);
	check("Obsidian's own rewrite of an opened note is the form the plugin allows for", readFileSync(join(vault, "inbox/windows.md")).equals(Buffer.from(asOpened(new TextEncoder().encode(WINDOWS)))));

	const idle = await run(`app.plugins.plugins["fold-memory"].syncNow(false).then(() => true)`).then(() => requests.length);
	const quiet = requests.slice(idle - 1);
	check("a timer's round with nothing changed asks only the status", quiet.length === 1 && quiet[0].path === "/v1/spaces/garden", quiet.map((r) => r.path).join(" "));

	await change("PUT", "inbox/windows.md", { text: "# Changed\n" });
	await change("DELETE", "managed/goes-away.md");
	const second = await syncNow();
	await until("the change", () => readFileSync(join(vault, "inbox/windows.md"), "utf8") === "# Changed\n");
	check("only the note that changed was read", second.filter((r) => r.path.includes("/content/")).map((r) => r.path).join() === "/v1/spaces/garden/content/inbox/windows.md", second.filter((r) => r.path.includes("/content/")).map((r) => r.path).join(" "));
	check("a note only opened in Obsidian is not taken for an edit: no copy was kept", !existsSync(join(vault, "inbox/windows (local edit).md")));
	check("a note Fold removed left the vault", !(await vaultFiles()).includes("managed/goes-away.md"));
	const inVaultTrash = existsSync(join(vault, ".trash/goes-away.md"));
	const inSystemTrash = existsSync(join(home, ".local/share/Trash/files/goes-away.md"));
	check("it went by way of the trash", inVaultTrash || inSystemTrash, inVaultTrash ? "the vault's .trash" : inSystemTrash ? "the system trash" : "not found in either");

	writeFileSync(join(vault, "inbox/windows.md"), "# My own edit\n");
	await until("Obsidian to see the edit", () => run(`app.vault.adapter.read("inbox/windows.md").then((t) => t === "# My own edit\\n")`));
	await sleep(500);
	await change("PUT", "inbox/windows.md", { text: "# Changed again\n" });
	await syncNow();
	await until("the new version", () => readFileSync(join(vault, "inbox/windows.md"), "utf8") === "# Changed again\n");
	check("a local edit is kept beside the new version", readFileSync(join(vault, "inbox/windows (local edit).md"), "utf8") === "# My own edit\n");

	await run(`app.commands.executeCommandById("app:open-settings")`);
	await sleep(1000);
	console.log("plugin tabs:", await run(`app.setting.pluginTabs.map((t) => t.id).join(",")`), "| open:", await run(`document.querySelectorAll(".modal-container").length`));
	await run(`app.setting.openTabById("fold-memory")`);
	await sleep(1500);
	const settings = await run(`app.setting.pluginTabs.find((t) => t.id === "fold-memory")?.containerEl?.innerText ?? ""`);
	check("the settings tab renders, with the token's secret picker", /Fold query address/.test(settings) && /Token/.test(settings) && /Check for changes/.test(settings), settings.replaceAll("\n", " / ").slice(0, 420));
	const tab = `app.setting.pluginTabs.find((t) => t.id === "fold-memory")`;
	check("it is drawn from its declarative definitions, so Obsidian's settings search finds them", await run(`${tab}.settingItems.map((d) => d.name).join() === "Fold query address,Token,Space,Check for changes"`), await run(`${tab}.settingItems.map((d) => d.name).join()`));
	check("a vault holding notes offers Disconnect, not another space", /Holding the notes of garden/.test(settings) && (await run(`[...${tab}.containerEl.querySelectorAll("button")].some((b) => b.innerText === "Disconnect")`)));
	check("the controls read this device's address and token name", (await run(`${tab}.getControlValue("queryUrl")`)) === `https://localhost:${PORT}` && (await run(`${tab}.getControlValue("secretName")`)) === "fold-token");
	await run(`${tab}.setControlValue("intervalMinutes", "15")`);
	check("choosing how often to check is saved with the vault", JSON.parse(readFileSync(join(pluginDir, "data.json"), "utf8")).intervalMinutes === 15 && (await run(`app.plugins.plugins["fold-memory"].settings.intervalMinutes`)) === 15);
	await run(`${tab}.setControlValue("intervalMinutes", "5")`);
	console.log("rows:", await run(`[...${tab}.containerEl.querySelectorAll(".setting-item")].map((row) => (row.querySelector(".setting-item-name")?.textContent ?? "?") + " = " + [...row.querySelectorAll("select, button, input")].map((e) => e.tagName + (e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ? "" : "(hidden)") + ":" + (e.tagName === "SELECT" ? e.value + "/" + [...e.options].map((o) => o.value + "=" + o.text).join(",") : e.value || e.innerText || "")).join(" ")).join(" | ")`));
	await screenshot("settings");
	await run(`app.setting.close()`);
	const listed = requests.filter((r) => r.path === "/v1/spaces").length;
	await run(`${tab}.update()`);
	await sleep(500);
	check("refreshing the closed tab asks nothing of Fold", requests.filter((r) => r.path === "/v1/spaces").length === listed);

	const before = await vaultFiles();
	const beforeBytes = readFileSync(join(vault, "inbox/windows.md"));
	await run(`app.plugins.plugins["fold-memory"].connection.space = "another"`);
	const switched = await syncNow();
	check("choosing another space while this vault holds notes changes nothing and asks nothing of Fold", JSON.stringify(await vaultFiles()) === JSON.stringify(before) && readFileSync(join(vault, "inbox/windows.md")).equals(beforeBytes) && switched.length === 0, switched.map((r) => r.path).join(" "));
	// Obsidian puts a notice in activeWindow, which under xvfb is often a hidden about:blank window, so look in both.
	check("and it says why", /another space/.test(await run(`[...new Set([document, activeWindow.document])].flatMap((d) => [...d.querySelectorAll(".notice")]).map((n) => n.textContent).join(" ")`)));
	await run(`app.plugins.plugins["fold-memory"].connection.space = "garden"`);
	await run(`app.plugins.plugins["fold-memory"].connection.secretName = "no-such-secret"`);
	await syncNow();
	check("a refused or missing token deletes nothing", (await vaultFiles()).includes("managed/roses.md"));
	await run(`app.plugins.plugins["fold-memory"].connection.secretName = "fold-token"`);

	// What Electron does with a bearer on a redirect to another host, since requestUrl offers no way to stop following.
	const redirectBefore = evilRequests.length;
	await run(`requestUrl({ url: "https://localhost:${PORT}/redirect-probe", headers: { authorization: "Bearer redirect-probe" }, throw: false }).catch(() => null)`);
	await sleep(800);
	const landed = evilRequests.slice(redirectBefore);
	// Known and recorded in the README: requestUrl follows a redirect and carries the header, with no way to stop it. This line says if that ever changes.
	console.log(landed.length === 0 ? "note redirect: not followed" : `note redirect: followed, bearer ${landed[0].auth ? "carried, as the README says" : "dropped, so the README can be relaxed"}`);
	check("nothing from this plugin reached the console as an error", !consoleProblems.some((p) => /fold|Fold|main\.js|plugin:fold-memory/.test(p)), consoleProblems.filter((p) => /fold|Fold|plugin:fold-memory/.test(p)).join(" | ").slice(0, 300));
	// Disconnect last, since it ends the copy: the tab redraws itself with update(), offering the space list again, and the notes stay.
	const kept = await vaultFiles();
	await run(`app.commands.executeCommandById("app:open-settings")`);
	await sleep(800);
	await run(`app.setting.openTabById("fold-memory")`);
	await sleep(1000);
	const listedBefore = requests.filter((r) => r.path === "/v1/spaces").length;
	await run(`[...${tab}.containerEl.querySelectorAll("button")].find((b) => b.innerText === "Disconnect").click()`);
	await until("the tab to offer a space again", () => run(`[...${tab}.containerEl.querySelectorAll("select option")].some((o) => o.text === "Choose a space")`), 10_000);
	await until("the space list", () => requests.filter((r) => r.path === "/v1/spaces").length > listedBefore, 10_000);
	check("Disconnect redraws the tab with the space list, and keeps the notes", JSON.stringify(await vaultFiles()) === JSON.stringify(kept) && (await run(`app.plugins.plugins["fold-memory"].connection.space`)) === "" && (await run(`Object.keys(app.plugins.plugins["fold-memory"].settings.sync.files).length`)) === 0);
	await screenshot("disconnected");
	await run(`app.setting.close()`);
	await run(`app.plugins.disablePlugin("fold-memory")`);
	check("the plugin unloads cleanly", await run(`!app.plugins.plugins["fold-memory"]`));
} catch (error) {
	check("the run finished", false, String(error).slice(0, 400));
	try {
		console.log("requests seen:", requests.length, requests.slice(0, 8).map((r) => `${r.method} ${r.path}`).join(" "));
		console.log("plugin state:", await run(`JSON.stringify({ running: app.plugins.plugins["fold-memory"]?.running, queryUrl: app.plugins.plugins["fold-memory"]?.connection?.queryUrl, secret: !!app.secretStorage.getSecret("fold-token"), notices: [...document.querySelectorAll(".notice")].map((n) => n.innerText), bar: document.querySelector(".plugin-fold-memory")?.textContent })`)); // secret-scan-ok: logs whether a secret exists, never its value
		console.log("a direct call:", await run(`Promise.race([window.fetch("https://localhost:${PORT}/v1/spaces", { headers: { authorization: "Bearer x" } }).then((r) => "fetch " + r.status, (e) => "fetch failed: " + e), new Promise((r) => setTimeout(() => r("fetch hung"), 5000))])`));
		console.log("requestUrl global:", await run(`typeof requestUrl`));
		console.log("on screen:", await run(`location.href + " | " + document.title + " | " + document.body.innerText.slice(0, 300).replaceAll("\\n", " / ")`));
		await screenshot("failure");
		console.log("console problems:", consoleProblems.slice(0, 5).join(" | ").slice(0, 600));
	} catch {}
} finally {
	try {
		process.kill(-app.pid, "SIGTERM");
	} catch {}
	server.close();
	evilServer.close();
	console.log(`\n${results.filter(Boolean).length} of ${results.length} passed`);
	setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 500);
}
