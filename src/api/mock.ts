/**
 * A typed, in-memory stand-in for Fold's HTTP API (planning/memory-spaces-first/README.md), until the spaces lane's routes are deployed. The Vite dev server mounts it (mock/dev-server.ts) and the tests call it through a mocked `fetch` (src/test/render.tsx), so the screens and their tests read one implementation of one contract. It is never part of the built app.
 *
 * What it models, as the README says: a write makes a new revision and the space answers `indexing` until the pointer moves; reads and search serve the indexed revision; the file list shows the newest one, each file marked indexed or not. Search is word overlap, enough to show the shape of an agent's results.
 */
import {
	type Access,
	type ApiErrorBody,
	GUIDANCE_FILES,
	type CommitUpload,
	type Conversion,
	type Converting,
	type CreateSpace,
	type Embedder,
	type FileList,
	type FileText,
	MAX_ORIGINAL_BYTES,
	MAX_QUERY_CHARS,
	MAX_CONTENT_BYTES,
	MAX_READ_LINES,
	MAX_SEARCH_LIMIT,
	type NewNote,
	type NewUpload,
	type NoteSaved,
	ORIGINAL_TYPES,
	type OriginalLink,
	originalType,
	type RestoreFile,
	type Revised,
	HASH_HEADER,
	REVISION_HEADER,
	reaches,
	type SearchHit,
	type SearchResults,
	type SpaceCreated,
	type SpaceGuide,
	type SpaceList,
	type SleepSettings,
	type SleepView,
	type SpaceSettings,
	type SpaceStatus,
	type UploadLink,
	isManaged,
	needsMemory,
	UNDELETABLE_FILES,
	type WriteFile,
} from "./types.ts";

type Files = Map<string, string>;
type Dates = Map<string, { created: string; updated: string }>;

interface MockSpace {
	id: string;
	organization: { id: string; name: string };
	access: Access;
	embedder: Embedder;
	/** Every revision's files and their dates, oldest first. */
	revisions: { id: string; files: Files; dates: Dates }[];
	/** Each file's version before its current one. */
	previous: Map<string, string>;
	/** Files that have left the space, and what they left. */
	deleted: Map<string, { text: string; at: string; filed: boolean }>;
	/** The revision reads and search serve; null until the first is indexed. */
	served: string | null;
	/** When the newest revision becomes the served one. */
	indexedAt: number;
	sleep: Omit<SleepView, "waiting">;
	/** Whether search blends a file's age into its ranking. */
	decay: boolean;
	/** The `memory` switch. */
	memory: boolean;
	/** Originals on their way in, and those that could not come, by path. */
	conversions: Map<string, MockConversion>;
	/** What each upload's link was for, and what has been sent through it. */
	uploads: Map<string, { bytes: number; sha256: string; sent?: Uint8Array }>;
	/** The revision a re-index was last asked for at, which every later revision carries (fold-store's `Revision.reindex`). */
	reindex?: string;
}

/** A conversion, and when it finishes, with what it finds. */
interface MockConversion extends Conversion {
	readyAt: number;
	finding: { text: string; hash: string; bytes: number } | { failure: keyof typeof CONVERSION_FAILURES };
}

/** The fixed sentences of the failures the mock can come to (fold-store's `ConversionFailure`). */
const CONVERSION_FAILURES = {
	"no-text": "it holds no text to index, as a scanned PDF does not: run it through OCR first",
	"not-this-type": "its contents are not the type its name says",
} as const;

/** Where the mock's upload links lead, and what is at the start of a file it finds has no text. */
export const MOCK_UPLOADS_URL = "https://uploads.fold.test";
export const SCANNED_MARK = "(scanned)";

export interface MockApiOptions {
	/** How long a write takes to index, in milliseconds. 0 indexes at once. */
	indexDelayMs?: number;
	/** The clock, so a test can move time. */
	now?: () => number;
	/** The spaces to start with; `seedSpaces()` by default. */
	spaces?: SeedSpace[];
	/** How long a conversion takes, in milliseconds. 0 converts at the next request. */
	convertDelayMs?: number;
	/** Where upload links lead, which the dev server serves. */
	uploadsUrl?: string;
}

export interface SeedSpace {
	id: string;
	organization: { id: string; name: string };
	access: Access;
	files: Record<string, string>;
	/** What sleep has recorded, when a test or the dev server wants some. */
	sleep?: Partial<Omit<SleepView, "waiting">>;
	/** The `memory` switch; on unless this says otherwise. */
	memory?: boolean;
}

export interface MockApi {
	/** One request in, one response out, for paths under the API's base (`/v1/...`). */
	handle: (request: Request) => Promise<Response>;
	/** Make every pending revision the served one now. */
	finishIndexing: () => void;
	/** The texts of a space's newest revision, for assertions. */
	headFiles: (space: string) => Record<string, string> | undefined;
	/** Files a note out of the inbox as sleep does, keeping its last version. */
	fileNote: (space: string, path: string) => void;
}

/** How long a file's last version stays (fold-store's KEEP_DELETED_SECONDS). */
const KEEP_DELETED_MS = 30 * 24 * 60 * 60 * 1000;

const EMBEDDER = { id: "amazon.titan-embed-text-v2:0", version: "1024" };
/** The embedder's own two scores: Titan V2's in the default registry (crates/fold-providers/default-registry.json). `MIN_SCORE` is the floor a search with no `minScore` keeps results from, and `GOOD_SCORE` the line try search splits at. Word overlap is another scale, but the floor still drops the sections that share no word with the query. */
const MIN_SCORE = 0.12;
const GOOD_SCORE = 0.25;
/** The embedder's decay, as the default registry has it, and fold-store's `Decay::weigh`. */
export const DECAY = { updatedHalfLifeDays: 30, createdHalfLifeDays: 180, updatedShare: 0.8, strengthFloor: 0.5, strengthWeight: 0.3 };
const DAY_MS = 86_400_000;
/** The most hits of one file a search returns while other files qualify (fold-query's MAX_PER_FILE). */
export const MAX_PER_FILE = 3;
/** When the seed's files arrived, unless a note's frontmatter says. */
const SEEDED_AT = "2026-11-01T09:00:00Z";
/** The query parameters a read takes; anything else is refused, as fold-query refuses it. */
const READ_PARAMETERS = ["lineStart", "lineEnd", "revision", "original"];
/** The largest line number fold-query takes: a read's lines are `u32`. */
const MAX_LINE_NUMBER = 4_294_967_295;
/** A file's text is at most 1 MiB this round (LOG.md 15:25, item 2). */
const MAX_FILE_BYTES = 1024 * 1024;
/** The most characters one line may hold (fold-control's MAX_LINE_CHARS). */
const MAX_LINE_CHARS = 4_000;
/** Sleep's starting defaults (fold-store's SleepSettings). */
const SLEEP_DEFAULTS: SleepSettings = { notes: 10, hours: 24 };
/** Fold's scan for credentials has many rules (fold-control's `credentials.rs`); the mock needs one to answer as it does. */
const LIKELY_CREDENTIAL = /\bA(?:KIA|SIA)[0-9A-Z]{16}/; // secret-scan-ok: the shape of a key, and no key
const NO_NOTES = "this space's memory is off, so it keeps no notes: documents go to reference/, and an admin can turn memory on";
const HOLDS_CREDENTIAL = "this note was not stored, since it holds what looks like an AWS access key: take it out and save again, or if it is meant to be there, send the same write again with confirm: true";

/** The first line over fold-control's limit as its refusal, or null: a line of the text as sent, `of` naming the text when a request holds several. */
function longLine(text: string, of?: string): Response | null {
	const at = text.split("\n").findIndex((line) => [...line.replace(/\r$/, "")].length > MAX_LINE_CHARS);
	if (at < 0) return null;
	return refuse(413, "line-too-long", `line ${at + 1}${of ? ` of ${of}` : ""} is longer than 4,000 characters: break it into lines or paragraphs`);
}

/** A note with what an Obsidian vault's notes hold, so the file page and the editor have all of it to show. */
const SOIL_PLAN = `---
title: Soil plan
tags:
  - soil
  - planning
status: draft
---

# Soil plan

The beds are in [[sowing-calendar|the sowing calendar]] order. See [[tomato-blight#Next year]] for why the tomatoes move, and [[a-note-not-written-yet]] for what comes after. #soil/2026

> [!tip] Before you dig
> Test the pH first. It takes **ten minutes** and saves a season.

## Beds

| Bed | Crop | pH |
| :-- | :-: | --: |
| North | Carrots | 6.5 |
| South | \`Garlic\` | 7.0 |

## This month

- [x] Order compost
- [ ] Lime the north bed
    - only if the test says so
- [ ] Sow green manure

1. Fork over.
2. Rake level.

\`\`\`text
lime (g/m2) = 200 * (6.5 - pH)
\`\`\`

A sum from the old notebook[^1], with <kbd>Ctrl</kbd>+<kbd>S</kbd> to save it, and a [link](https://example.com/soil) out.

<script>alert("a note's HTML never runs")</script>

![The north bed](https://example.com/north-bed.png)

[^1]: Written down in 2019.
`;

/** The seed for the dev server: the same spaces, with a note that shows everything the file page and the editor draw. The tests keep the plain seed, whose search results they pin. */
export function devSpaces(): SeedSpace[] {
	const started = Math.floor(Date.now() / 1000) - 7_200;
	const sleep: SeedSpace["sleep"] = {
		runs: [
			{
				id: "run-sample",
				startedAt: started,
				finishedAt: started + 94,
				status: "done",
				reason: null,
				notesFiled: 9,
				notesSetAside: 1,
				batches: 3,
				conflicts: 0,
				modelCalls: 5,
				inputTokens: 4_210,
				outputTokens: 3_020,
				cacheReadTokens: 21_400,
				cacheWriteTokens: 8_900,
				consolidated: true,
				nominated: true,
			},
		],
		setAside: [{ path: "inbox/tomato-blight.md", reason: "model-refused-the-note", at: started + 60 }],
		evolutions: [
			{
				id: "evolve-sample",
				startedAt: started + 120,
				finishedAt: started + 180,
				status: "done",
				reason: null,
				kind: "categories",
				paths: ["managed/crops"],
				changed: ["SLEEP.md", "DREAMS.md"],
				notesMoved: 3,
				suggestion: "Say that the space covers the greenhouse too.",
				searches: 4,
				reads: 6,
				modelCalls: 5,
				inputTokens: 1_020,
				outputTokens: 880,
				cacheReadTokens: 41_000,
				cacheWriteTokens: 9_300,
			},
		],
	};
	return seedSpaces().map((space) => (space.id === "garden-notes" ? { ...space, sleep, files: { ...space.files, "reference/soil-plan.md": SOIL_PLAN } } : space));
}

/** Two spaces of the person's and one they can only read, so every state has something to show. */
export function seedSpaces(): SeedSpace[] {
	return [
		{
			id: "garden-notes",
			organization: { id: "org-test", name: "Test Organisation" },
			access: "admin",
			files: {
				"PURPOSE.md": "# Garden notes\n\nWhat we learn growing vegetables on the allotment: what worked, what failed, and when to plant.\n",
				"OVERVIEW.md":
					"Planting dates, soil fixes and pest notes from three seasons on the allotment. Notes are grouped by crop, newest first.\n",
				"SAVING.md":
					"Save what happened and when: the crop, the date, what you did and what came of it. One note per observation.\n",
				"inbox/tomato-blight.md":
					"---\ncreated: 2026-08-14T09:12:00Z\n---\n\n# Tomato blight in August\n\nBlight reached the outdoor tomatoes after a week of warm rain. Removing the lower leaves early slowed it.\n\nNext year: plant blight-resistant varieties and water at the base only.\n",
				"reference/sowing-calendar.md":
					"# Sowing calendar\n\nBroad beans go in during November. Carrots wait until April, when the soil is warmer.\n\nGarlic is planted before the shortest day and lifted in July.\n",
			},
		},
		{
			id: "team-handbook",
			organization: { id: "org-rose", name: "Rose & Co" },
			access: "read",
			files: {
				"PURPOSE.md": "# Team handbook\n\nHow the team works: on-call, reviews and releases.\n",
				"OVERVIEW.md": "The team's agreed ways of working, from on-call rotas to release checklists.\n",
				"SAVING.md": "Only the handbook's editors save here.\n",
				"managed/release-checks.md":
					"---\ncreated: 2026-05-02T08:00:00Z\nupdated: 2026-08-20T18:30:00Z\n---\n\n# Release checks\n\nRun the smoke tests before a release, and name who is on call.\n",
				"reference/on-call.md": "# On-call\n\nThe rota changes every Monday at nine. Hand over open incidents in writing.\n",
			},
		},
	];
}

/** Where a write may go, as fold-control's door says. */
function writable(path: string): boolean {
	return GUIDANCE_FILES.has(path) || path.startsWith("inbox/") || path.startsWith("reference/");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function refuse(status: number, error: string, detail: string): Response {
	const body: ApiErrorBody = { error, detail };
	return json(status, body);
}

const notFound = () => refuse(404, "not-found", "no such space, or no access to it");
const forbidden = (level: Access) => refuse(403, "not-permitted", `this needs ${level} access to the space`);

/** The original a path is the text of (fold-store's `original_of_text`), whether or not it exists. */
function originalOfText(path: string): string | null {
	if (!path.startsWith("reference/") || !/\.md$/i.test(path)) return null;
	const stem = path.slice(0, -3);
	return originalType(stem) === null ? null : stem;
}

const TEXT_IS_FOLDS = "Fold writes a converted file's text, and nobody else: a new original converts again and replaces it, and deleting the original removes it";

function firstSentence(text: string): string {
	const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#.*$/gm, "").trim();
	const match = /^[\s\S]*?[.!?](\s|$)/.exec(body);
	return (match ? match[0] : body).trim().replace(/\s+/g, " ");
}

function titleOf(files: Files, fallback: string): string {
	const heading = /^#\s+(.+)$/m.exec(files.get("PURPOSE.md") ?? "");
	return heading?.[1]?.trim() ?? fallback;
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "note"
	);
}

/** Checks a body has exactly the fields named, each a string where given. */
function strictBody<T>(raw: unknown, required: string[], optional: string[], flags: string[] = []): T | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!required.includes(key) && !optional.includes(key) && !flags.includes(key)) return null;
	}
	for (const key of flags) if (key in record && typeof record[key] !== "boolean") return null;
	for (const key of required) if (typeof record[key] !== "string") return null;
	for (const key of optional) if (key in record && typeof record[key] !== "string") return null;
	return record as T;
}

/** A space's files as sections an agent would get back: one per heading or paragraph run, with its lines. */
function sections(path: string, text: string): Pick<SearchHit, "path" | "title" | "summary" | "lineStart" | "lineEnd">[] {
	const lines = text.split("\n");
	const found: Pick<SearchHit, "path" | "title" | "summary" | "lineStart" | "lineEnd">[] = [];
	let start = 0;
	const flush = (end: number) => {
		const chunk = lines.slice(start, end).join("\n").trim();
		if (chunk && !/^---[\s\S]*---$/.test(chunk)) {
			const heading = /^#+\s+(.+)$/m.exec(chunk)?.[1];
			found.push({
				path,
				title: heading ?? path.split("/").pop() ?? path,
				summary: firstSentence(chunk) || chunk.slice(0, 160),
				lineStart: start + 1,
				lineEnd: end,
			});
		}
		start = end;
	};
	lines.forEach((line, index) => {
		if (index > start && (/^#/.test(line) || line.trim() === "")) flush(index);
	});
	flush(lines.length);
	return found;
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** SHA-256 of a file's bytes in lower-case hex, as fold-store's ContentHash. */
async function contentHashOf(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function contentHash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** RFC 3339 in UTC, to the second, as fold-store's Timestamp writes a moment. */
function stamp(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

/** What a note's frontmatter says of a date, if it is one (fold-store's `stated_dates`). */
function statedDate(path: string, text: string, key: "created" | "updated"): string | undefined {
	if (!/^(inbox|managed)\/.+\.(md|markdown|mdx)$/i.test(path)) return undefined;
	const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text)?.[1] ?? "";
	const value = new RegExp(`^${key}[ \\t]*:[ \\t]*["']?([^"'#\\r\\n]+)`, "im").exec(block)?.[1]?.trim() ?? "";
	// The forms fold-store's Timestamp reads, a date with no time or zone being UTC, and never a day the month does not have.
	const shape = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
	if (!shape) return undefined;
	const [, day, time = "00:00:00", zone = "Z"] = shape;
	const ms = Date.parse(`${day}T${time}${zone}`);
	return Number.isNaN(ms) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ? undefined : stamp(ms);
}

/** What a commit records for each file (fold-store's `FileEntry::written` and `StatedDates`): the same text keeps its dates, and changed text keeps `created` and is `updated` now. A note's frontmatter wins, unless it says a date yet to come, and `updated` is never before `created`: `updated` alone brings a later `created` back to it, and a new note's `created` alone is also when it last changed. This API has no call that moves a file, so there is no move to keep dates across. */
function datesOf(files: Files, was: { files: Files; dates: Dates }, at: string): Dates {
	const dates: Dates = new Map();
	for (const [path, text] of files) {
		const held = was.dates.get(path);
		if (held && was.files.get(path) === text) {
			dates.set(path, held);
			continue;
		}
		const real = (date: string | undefined) => (date !== undefined && date <= at ? date : undefined);
		const [statedCreated, statedUpdated] = [real(statedDate(path, text, "created")), real(statedDate(path, text, "updated"))];
		const unstated = held?.created ?? at;
		const created = statedCreated ?? (statedUpdated !== undefined && statedUpdated < unstated ? statedUpdated : unstated);
		const updated = statedUpdated ?? (held ? at : created);
		dates.set(path, { created, updated: updated < created ? created : updated });
	}
	return dates;
}

/** `Decay::weigh`: the file's strength, and the rank that blends it with similarity. A date yet to come counts as now. */
function weigh(score: number, created: string, updated: string, now: number): { strength: number; rank: number } {
	const fading = (date: string, halfLife: number) => 0.5 ** (Math.max(now - Date.parse(date), 0) / DAY_MS / halfLife);
	const aged = DECAY.updatedShare * fading(updated, DECAY.updatedHalfLifeDays) + (1 - DECAY.updatedShare) * fading(created, DECAY.createdHalfLifeDays);
	const strength = Math.min(DECAY.strengthFloor + (1 - DECAY.strengthFloor) * aged, 1);
	return { strength, rank: (1 - DECAY.strengthWeight) * score + DECAY.strengthWeight * strength };
}

/** Hits in rank order, as fold-query's `capped`: each file's best first, then the rest, with `seen` holding one file to the same cap across calls. */
function capped<T extends { path: string }>(ranked: T[], seen: Map<string, number>): T[] {
	const first: T[] = [];
	const rest: T[] = [];
	for (const hit of ranked) {
		const count = (seen.get(hit.path) ?? 0) + 1;
		seen.set(hit.path, count);
		(count <= MAX_PER_FILE ? first : rest).push(hit);
	}
	return [...first, ...rest];
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
	const now = options.now ?? Date.now;
	const delay = options.indexDelayMs ?? 0;
	const convertDelay = options.convertDelayMs ?? 0;
	const uploadsUrl = options.uploadsUrl ?? MOCK_UPLOADS_URL;
	const spaces = new Map<string, MockSpace>();

	for (const seed of options.spaces ?? seedSpaces()) {
		const id = "1";
		const files: Files = new Map(Object.entries(seed.files));
		spaces.set(seed.id, {
			id: seed.id,
			organization: seed.organization,
			access: seed.access,
			embedder: EMBEDDER,
			revisions: [{ id, files, dates: datesOf(files, { files: new Map(), dates: new Map() }, SEEDED_AT) }],
			previous: new Map(),
			deleted: new Map(),
			sleep: { settings: { ...SLEEP_DEFAULTS }, runs: [], setAside: [], evolutions: [], nominations: [], ...seed.sleep },
			memory: seed.memory ?? true,
			served: id,
			indexedAt: 0,
			decay: true,
			conversions: new Map(),
			uploads: new Map(),
		});
	}

	const head = (space: MockSpace) => space.revisions[space.revisions.length - 1] ?? { id: "", files: new Map() as Files, dates: new Map() as Dates };

	/** Moves the pointer once the newest revision's indexing time has passed, and lands a conversion whose time has. */
	const settle = (space: MockSpace) => {
		for (const conversion of [...space.conversions.values()]) {
			if (conversion.state !== "converting" || now() < conversion.readyAt) continue;
			const { finding } = conversion;
			if ("failure" in finding) {
				Object.assign(conversion, { state: "failed", reason: finding.failure, detail: CONVERSION_FAILURES[finding.failure] });
				continue;
			}
			space.conversions.delete(conversion.path);
			commit(space, (files) => {
				files.set(conversion.path, `original ${finding.hash} ${finding.bytes}`);
				files.set(`${conversion.path}.md`, finding.text);
			});
		}
		if (now() >= space.indexedAt) space.served = head(space).id;
	};

	const served = (space: MockSpace) => space.revisions.find((revision) => revision.id === space.served);

	/** A new revision, numbered within its space as the API numbers them; indexing waits `delay` unless the change needs none. */
	const commit = (space: MockSpace, change: (files: Files) => void, indexes = true): string => {
		const before = head(space);
		const files = new Map(before.files);
		change(files);
		const id = String(space.revisions.length + 1);
		// Each file keeps the version before its current one, and a file that left keeps its last (fold-store's commit).
		for (const [path, text] of before.files) {
			if (!files.has(path)) space.deleted.set(path, { text, at: stamp(now()), filed: false });
			else if (files.get(path) !== text) space.previous.set(path, text);
		}
		for (const [path, text] of files) {
			if (before.files.has(path)) continue;
			const left = space.deleted.get(path);
			if (left && left.text !== text) space.previous.set(path, left.text);
			else space.previous.delete(path);
			space.deleted.delete(path);
		}
		for (const path of space.previous.keys()) if (!files.has(path)) space.previous.delete(path);
		space.revisions.push({ id, files, dates: datesOf(files, before, stamp(now())) });
		space.indexedAt = indexes ? now() + delay : 0;
		settle(space);
		return id;
	};

	const status = (space: MockSpace): SpaceStatus => ({
		id: space.id,
		title: titleOf(head(space).files, space.id),
		state: space.served === head(space).id ? "ready" : "indexing",
		revision: head(space).id,
		servedRevision: space.served,
		embedder: space.embedder,
		decay: space.decay,
		memory: space.memory,
		...(reaches(space.access, "contribute") && space.conversions.size > 0
			? { conversions: [...space.conversions.values()].map(({ path, state, reason, detail, at }) => ({ path, state, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), at })) }
			: {}),
	});

	async function readJson(request: Request): Promise<unknown> {
		try {
			return await request.json();
		} catch {
			return undefined;
		}
	}

	/** What the store does with a request through a link: the link's own terms, and no bearer. */
	async function store(request: Request): Promise<Response> {
		const [spaceId, upload] = new URL(request.url).pathname.split("/").filter(Boolean);
		const held = spaces.get(spaceId ?? "")?.uploads.get(upload ?? "");
		if (request.method !== "PUT" || !held) return new Response("no such link", { status: 403 });
		const sent = new Uint8Array(await request.arrayBuffer());
		if (sent.length !== held.bytes || (await contentHashOf(sent)) !== held.sha256) return new Response("not what the link is for", { status: 400 });
		held.sent = sent;
		return new Response(null, { status: 200 });
	}

	async function route(request: Request): Promise<Response> {
		if (request.url.startsWith(uploadsUrl)) return store(request);
		const auth = request.headers.get("authorization") ?? "";
		if (!/^Bearer \S+$/.test(auth)) return refuse(401, "unauthorised", "the credential was refused");

		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const method = request.method;
		if (parts[0] !== "v1" || parts[1] !== "spaces") return notFound();

		// /v1/spaces
		if (parts.length === 2) {
			if (method === "GET") {
				const list: SpaceList["spaces"] = [...spaces.values()].map((space) => {
					settle(space);
					const files = head(space).files;
					return {
						id: space.id,
						title: titleOf(files, space.id),
						summary: firstSentence(files.get("OVERVIEW.md") ?? ""),
						organization: space.organization,
						access: space.access,
						via: space.access === "admin" ? ("owner" as const) : ("direct" as const),
						state: space.served === head(space).id ? ("ready" as const) : ("indexing" as const),
						revision: head(space).id,
					};
				});
				return json(200, { count: list.length, spaces: list } satisfies SpaceList);
			}
			if (method === "POST") {
				const body = strictBody<CreateSpace>(await readJson(request), ["title", "purpose"], ["organization", "overview", "saving"], ["memory"]);
				if (!body) return refuse(400, "bad-request", "the body must be { organization?, title, purpose, overview?, saving?, memory? } and nothing else");
				const memory = body.memory ?? true;
				if (!memory && body.saving !== undefined) return refuse(400, "bad-request", "a space with memory off takes no notes, so it has no saving guidance");
				// The web app's token is never bound to an organisation.
				if (body.organization === undefined) return refuse(400, "bad-request", "organization is required unless your token is bound to one organisation");
				if (!body.title.trim()) return refuse(400, "bad-request", "title is empty");
				if (!body.purpose.trim()) return refuse(400, "bad-request", "purpose is empty");
				if (!/^[a-z0-9-]+$/.test(body.organization)) return refuse(404, "not-found", "no such organisation, or no right to make a space there");
				const tooLong =
					longLine(body.purpose, "the purpose") ?? longLine(body.overview ?? "", "the overview") ?? longLine(body.saving ?? "", "the saving guidance");
				if (tooLong) return tooLong;
				let id = slug(body.title);
				while (spaces.has(id)) id = `${slug(body.title)}-${Math.floor(Math.random() * 1000)}`;
				const known = [...spaces.values()].find((other) => other.organization.id === body.organization)?.organization;
				const space: MockSpace = {
					id,
					organization: known ?? { id: body.organization, name: body.organization },
					access: "admin",
					embedder: EMBEDDER,
					revisions: [],
					previous: new Map(),
					deleted: new Map(),
					served: null,
					indexedAt: 0,
					sleep: { settings: { ...SLEEP_DEFAULTS }, runs: [], setAside: [], evolutions: [], nominations: [] },
					decay: true,
					memory,
					conversions: new Map(),
					uploads: new Map(),
				};
				spaces.set(id, space);
				const revision = commit(space, (files) => {
					files.set("PURPOSE.md", `# ${body.title.trim()}\n\n${body.purpose.trim()}\n`);
					files.set("OVERVIEW.md", `${body.overview?.trim() || `This space holds ${firstSentence(body.purpose).replace(/^./, (c) => c.toLowerCase())}`}\n`);
					if (memory) files.set("SAVING.md", `${body.saving?.trim() || "Save one note per thing learned: what happened, when, and why it matters."}\n`);
				}, false); // Guidance files are never indexed, so a new space is ready at once (LOG.md 15:25, item 4).
				return json(201, { id, revision } satisfies SpaceCreated);
			}
			return refuse(405, "bad-request", "that method is not served here");
		}

		const space = spaces.get(parts[2] ?? "");
		if (!space) return notFound();
		settle(space);
		const tail = parts.slice(3);

		if (tail.length === 0 && method === "GET") return json(200, status(space));

		if (tail[0] === "guide" && tail.length === 1 && method === "GET") {
			const files = served(space)?.files ?? head(space).files;
			return json(200, {
				overview: files.get("OVERVIEW.md") ?? "",
				saving: files.get("SAVING.md") ?? "",
				access: space.access,
				memory: space.memory,
			} satisfies SpaceGuide);
		}

		if (tail[0] === "search" && tail.length === 1) {
			if (method !== "POST") return refuse(400, "bad-request", "search is a POST");
			const raw = await readJson(request);
			const body = raw as { query?: unknown; limit?: unknown; minScore?: unknown; decay?: unknown } | undefined;
			const known = (key: string) => key === "query" || key === "limit" || key === "minScore" || key === "decay";
			if (
				typeof body?.query !== "string" ||
				typeof body.limit !== "number" ||
				!["undefined", "number"].includes(typeof body.minScore) ||
				!["undefined", "boolean"].includes(typeof body.decay) ||
				!Object.keys(body).every(known)
			) {
				return refuse(400, "bad-request", "the body must be { query, limit, minScore?, decay? } and nothing else");
			}
			if (!body.query.trim()) return refuse(400, "bad-request", "query is empty");
			if ([...body.query].length > MAX_QUERY_CHARS) return refuse(400, "bad-request", "query is longer than 2,000 characters");
			if (body.limit < 1 || body.limit > MAX_SEARCH_LIMIT) return refuse(400, "bad-request", "limit must be from 1 to 20");
			const minScore = typeof body.minScore === "number" ? body.minScore : MIN_SCORE;
			if (minScore < -1 || minScore > 1) return refuse(400, "bad-request", "minScore must be from -1 to 1");
			const revision = served(space);
			if (!revision) return refuse(409, "indexing", "the space has no indexed revision yet");
			const asked = new Set(words(body.query));
			const decay = space.decay && body.decay !== false;
			const ranked = [...revision.files.entries()]
				.filter(([path]) => !GUIDANCE_FILES.has(path) && originalType(path) === null)
				.flatMap(([path, text]) => sections(originalOfText(path) ?? path, text))
				.map((section) => {
					const found = words(`${section.title} ${section.summary}`);
					const matched = [...asked].filter((word) => found.includes(word)).length;
					const score = Math.round((matched / Math.max(asked.size, 1)) * 1000) / 1000;
					const dates = revision.dates.get(section.path) ?? { created: SEEDED_AT, updated: SEEDED_AT };
					const weighed = decay ? weigh(score, dates.created, dates.updated, now()) : undefined;
					const hit: SearchHit = { ...section, score, revision: revision.id, ...dates, ...(weighed ? { strength: weighed.strength } : {}), related: [], linked: [] };
					return { path: hit.path, hit, rank: weighed?.rank ?? score };
				})
				.filter(({ hit }) => hit.score >= minScore)
				.sort((a, b) => b.rank - a.rank);
			// What a search with no minScore gets comes first, as fold-query orders it, however fresh what is under the floor.
			const over = ranked.filter(({ hit }) => hit.score >= MIN_SCORE);
			const under = ranked.filter(({ hit }) => hit.score < MIN_SCORE);
			// The first hit of a file is a result; its other hits are related sections, as fold-query groups them.
			const results: SearchHit[] = [];
			const seen = new Map<string, number>();
			for (const { hit } of [...capped(over, seen), ...capped(under, seen)].slice(0, body.limit)) {
				const first = results.find((result) => result.path === hit.path);
				if (first) first.related.push(hit);
				else results.push(hit);
			}
			const embedder = { ...space.embedder, minScore: MIN_SCORE, goodScore: GOOD_SCORE };
			return json(200, { space: space.id, revision: revision.id, embedder, results } satisfies SearchResults);
		}

		if (tail[0] === "settings" && tail.length === 1 && method === "PUT") {
			if (!reaches(space.access, "admin")) return forbidden("admin");
			const body = strictBody<Partial<SpaceSettings>>(await readJson(request), [], [], ["decay", "memory"]);
			if (body?.decay === undefined && body?.memory === undefined) return refuse(400, "bad-request", "the body must be { decay?, memory? }, with at least one, and nothing else");
			space.decay = body.decay ?? space.decay;
			space.memory = body.memory ?? space.memory;
			return json(200, { decay: space.decay, memory: space.memory } satisfies SpaceSettings);
		}

		if (tail[0] === "reindex" && tail.length === 1) {
			if (method !== "POST") return refuse(400, "bad-request", "that method is not one this route takes");
			if ([...url.searchParams.keys()].length > 0) return refuse(400, "bad-request", "an unknown query parameter");
			// The body is checked before access, as the API checks it.
			const sent = await request.text();
			let raw: unknown = {};
			if (sent !== "") {
				try {
					raw = JSON.parse(sent);
				} catch {
					raw = null;
				}
			}
			if (strictBody(raw, [], []) === null) return refuse(400, "bad-request", "a re-index takes no body, or an empty object");
			if (!reaches(space.access, "admin")) return refuse(403, "not-permitted", "re-indexing a space needs admin access to it");
			if (space.served === null) return refuse(409, "indexing", "the space has no indexed revision yet");
			if (space.reindex !== undefined && Number(space.served) < Number(space.reindex)) {
				return refuse(409, "reindexing", "a re-index of this space is already queued or running, so this one starts nothing: the space's status says indexing until it is done");
			}
			// The latest revision again, unchanged: it changes no file, and the space says indexing until it is served.
			const revision = commit(space, () => {});
			space.reindex = revision;
			return json(202, { revision } satisfies Revised);
		}

		if (tail[0] === "sleep" && tail.length === 1) {
			if (method === "GET") {
				if (!reaches(space.access, "contribute")) return forbidden("contribute");
				const set = new Set(space.sleep.setAside.map((aside) => aside.path));
				const waiting = [...head(space).files.keys()].filter((path) => path.startsWith("inbox/") && !set.has(path)).length;
				return json(200, { ...space.sleep, waiting } satisfies SleepView);
			}
			if (method === "PUT") {
				if (!reaches(space.access, "admin")) return forbidden("admin");
				const raw = await readJson(request);
				const keys = raw && typeof raw === "object" ? Object.keys(raw).toSorted() : [];
				const body = keys.join() === "hours,notes" ? (raw as SleepSettings) : null;
				if (!body || !Number.isInteger(body.notes) || !Number.isInteger(body.hours) || body.notes < 1 || body.notes > 1000 || body.hours < 1 || body.hours > 720) {
					return refuse(400, "bad-request", "notes must be from 1 to 1,000 and hours from 1 to 720");
				}
				space.sleep.settings = body;
				return json(200, body);
			}
			return refuse(400, "bad-request", "that method is not one this route takes");
		}

		if (tail[0] === "notes" && tail.length === 1 && method === "POST") {
			if (!reaches(space.access, "contribute")) return forbidden("contribute");
			if (!space.memory) return refuse(409, "memory-off", NO_NOTES);
			const body = strictBody<NewNote>(await readJson(request), ["text"], ["title"], ["confirm"]);
			if (!body || !body.text.trim()) return refuse(400, "bad-request", "the body must be { text, title? } with some text");
			const tooLong = longLine(body.text);
			if (tooLong) return tooLong;
			if (!body.confirm && LIKELY_CREDENTIAL.test(body.text)) return refuse(400, "holds-credential", HOLDS_CREDENTIAL);
			const name = slug(body.title?.trim() || body.text.trim().split("\n")[0] || "note");
			let path = `inbox/${name}.md`;
			for (let n = 2; head(space).files.has(path); n++) path = `inbox/${name}-${n}.md`;
			const heading = body.title?.trim() ? `# ${body.title.trim()}\n\n` : "";
			const revision = commit(space, (files) => files.set(path, `---\ncreated: ${new Date(now()).toISOString()}\n---\n\n${heading}${body.text.trim()}\n`));
			return json(201, { path, revision } satisfies NoteSaved);
		}

		if (tail[0] === "uploads" && method === "POST") {
			if (!reaches(space.access, "contribute")) return forbidden("contribute");
			// As fold-control's: a number where a size goes, and nothing else named.
			const raw = (await readJson(request)) as (NewUpload & CommitUpload) | undefined;
			const known = (key: string) => ["path", "bytes", "sha256", "ifRevision"].includes(key);
			if (!raw || typeof raw.path !== "string" || typeof raw.sha256 !== "string" || typeof raw.bytes !== "number" || !Object.keys(raw).every(known)) {
				return refuse(400, "bad-request", "the body must be { path, bytes, sha256 } and nothing else");
			}
			const body = raw;
			const declared = raw.bytes;
			const type = originalType(body.path);
			if (type === null) return /\.(pdf|docx|pptx)$/i.test(body.path) ? refuse(415, "unsupported-type", "the inbox holds only notes and managed/ only what sleep files: an original (PDF, Word or PowerPoint) goes to reference/") : refuse(415, "unsupported-type", "a space takes Markdown, plain text, CSV, TSV, JSON, YAML, TOML and source code, as UTF-8 text, and PDF, Word (.docx) and PowerPoint (.pptx) files, uploaded to reference/, which it converts: convert anything else first, and a file whose contents are not what its name says will not go in under that name");
			if (declared > MAX_ORIGINAL_BYTES) return refuse(413, "too-large", "an original is at most 80 MB");
			if (tail.length === 1) {
				const upload = `up${space.uploads.size + 1}`;
				space.uploads.set(upload, { bytes: declared, sha256: body.sha256 });
				return json(201, { upload, url: `${uploadsUrl}/${space.id}/${upload}`, method: "PUT", headers: { "content-type": "application/octet-stream" }, expiresAt: stamp(now() + 900_000) } satisfies UploadLink);
			}
			const held = space.uploads.get(tail[1] ?? "");
			if (!held?.sent) return refuse(400, "bad-request", "nothing has been sent through that link, or it was sent too long ago: ask for another");
			if (held.bytes !== declared || held.sha256 !== body.sha256) return refuse(400, "bad-request", "what was sent is not the size and SHA-256 this names");
			if (head(space).files.has(body.path) && !reaches(space.access, "edit")) return forbidden("edit");
			const first = new TextDecoder("latin1").decode(held.sent.slice(0, 5));
			if (type === "pdf" ? !first.startsWith("%PDF-") : !first.startsWith("PK\x03\x04")) return refuse(415, "unsupported-type", "a space takes Markdown, plain text, CSV, TSV, JSON, YAML, TOML and source code, as UTF-8 text, and PDF, Word (.docx) and PowerPoint (.pptx) files, uploaded to reference/, which it converts: convert anything else first, and a file whose contents are not what its name says will not go in under that name");
			const name = body.path.slice(body.path.lastIndexOf("/") + 1);
			const scanned = new TextDecoder("latin1").decode(held.sent).includes(SCANNED_MARK);
			space.conversions.set(body.path, {
				path: body.path,
				state: "converting",
				at: stamp(now()),
				readyAt: now() + convertDelay,
				finding: scanned ? { failure: "no-text" } : { text: `# ${name}\n\nThe ${ORIGINAL_TYPES[type]} text of ${name}.\n`, hash: body.sha256, bytes: held.bytes },
			});
			return json(202, { path: body.path, state: "converting" } satisfies Converting);
		}

		// A file as it is stored, under the same rule as a line read (LOG.md 21:35).
		if (tail[0] === "content" && method === "GET") {
			const path = tail.slice(1).join("/");
			if (!path || path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
				return refuse(400, "bad-request", "the file path is not a path in a space");
			}
			if (originalType(path) !== null && !reaches(space.access, "edit")) return refuse(403, "not-permitted", "an original needs edit access: a read gives its text");
			if (originalOfText(path) !== null) return refuse(404, "file-not-found", "that revision of the space has no indexed file at that path");
			const revision = GUIDANCE_FILES.has(path) ? head(space) : served(space);
			if (!revision) return refuse(409, "indexing", "the space has no indexed revision yet");
			const text = revision.files.get(path);
			if (text === undefined) return refuse(404, "file-not-found", "the space's current revision has no indexed file at that path");
			const asked = url.searchParams.get("revision");
			if (asked && asked !== revision.id) return refuse(409, "changed", "the space no longer serves that revision");
			const bytes = new TextEncoder().encode(text);
			if (bytes.length > MAX_CONTENT_BYTES) return refuse(413, "too-large", "this file is too large for one answer");
			return new Response(bytes, {
				status: 200,
				headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-store", [REVISION_HEADER]: revision.id, [HASH_HEADER]: await contentHash(text) },
			});
		}

		if (tail[0] === "restore") {
			const path = tail.slice(1).join("/");
			if (method !== "POST" || !path) return refuse(400, "bad-request", "that method is not one this route takes");
			if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
				return refuse(400, "bad-request", "the file path is not a path in a space");
			}
			if (isManaged(path)) return refuse(403, "not-permitted", "sleep alone writes managed notes: to correct one, save a note to the inbox and sleep files the correction");
			if (originalOfText(path) !== null) return refuse(403, "not-permitted", TEXT_IS_FOLDS);
			if (!writable(path)) return refuse(400, "bad-request", "a space's files are its guidance files at the root and everything under inbox/ and reference/");
			if (!reaches(space.access, "edit")) return forbidden("edit");
			if (!space.memory && needsMemory(path)) return refuse(409, "memory-off", NO_NOTES);
			const body = strictBody<RestoreFile>((await request.clone().text()) ? await readJson(request) : {}, [], ["ifRevision"], ["confirm"]);
			if (!body) return refuse(400, "bad-request", "the body must be { ifRevision?, confirm? } and nothing else");
			const current = head(space).files.get(path);
			const left = space.deleted.get(path);
			const version = current === undefined ? left?.text : space.previous.get(path);
			if (version === undefined) return current === undefined ? refuse(404, "file-not-found", "that revision of the space has no indexed file at that path") : refuse(409, "no-previous-version", "this file has no earlier version to put back");
			if (originalType(path) !== null) {
				const textPath = `${path}.md`;
				const text = current === undefined ? space.deleted.get(textPath)?.text : space.previous.get(textPath);
				const [, hash = "", bytes = "0"] = version.split(" ");
				space.conversions.set(path, { path, state: "converting", at: stamp(now()), readyAt: now() + convertDelay, finding: { text: text ?? head(space).files.get(textPath) ?? "", hash, bytes: Number(bytes) } });
				return json(202, { path, state: "converting" } satisfies Converting);
			}
			if (current === undefined && left?.filed && !reaches(space.access, "admin")) return refuse(403, "not-permitted", "only an admin can bring back a note sleep has filed");
			if (!body.confirm && path.startsWith("inbox/") && LIKELY_CREDENTIAL.test(version)) return refuse(400, "holds-credential", HOLDS_CREDENTIAL);
			if (body.ifRevision !== undefined) {
				const then = space.revisions.find((revision) => revision.id === body.ifRevision);
				if (!then || then.files.get(path) !== current) return refuse(409, "changed", "the file changed after that revision");
			}
			const revision = commit(space, (files) => files.set(path, version));
			return json(200, { revision } satisfies Revised);
		}

		if (tail[0] === "files") {
			const path = tail.slice(1).join("/");
			if (!path) {
				if (method !== "GET") return refuse(400, "bad-request", "that method is not served here");
				const prefix = url.searchParams.get("prefix") ?? "";
				const indexed = served(space)?.files;
				const files = await Promise.all(
					[...head(space).files.entries()]
						.filter(([name]) => name.startsWith(prefix) && originalOfText(name) === null)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(async ([name, text]) => {
							const type = originalType(name);
							const [, hash = "", bytes = "0"] = text.split(" ");
							return {
								path: name,
								bytes: type ? Number(bytes) : new TextEncoder().encode(text).length,
								hash: GUIDANCE_FILES.has(name) || name.startsWith("system/") ? null : type ? (reaches(space.access, "edit") ? hash : null) : await contentHash(text),
								indexed: !GUIDANCE_FILES.has(name) && indexed?.get(name) === text,
								hasPrevious: space.previous.has(name),
								previousFiled: false,
								...(type ? { original: type } : {}),
							};
						}),
				);
				const deleted = [...space.deleted.entries()]
					.filter(([name]) => name.startsWith(prefix) && originalOfText(name) === null)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, left]) => ({ path: name, deletedAt: left.at, keptUntil: stamp(Date.parse(left.at) + KEEP_DELETED_MS), filed: left.filed }));
				return json(200, { revision: head(space).id, files, deleted } satisfies FileList);
			}
			if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
				return refuse(400, "bad-request", "the file path is not a path in a space");
			}
			if (method === "GET") {
				// The real API's checks of a read's parameters, so the app cannot send what fold-query refuses.
				const names = [...url.searchParams.keys()];
				if (names.some((name) => !READ_PARAMETERS.includes(name))) return refuse(400, "bad-request", "an unknown query parameter");
				if (new Set(names).size !== names.length) return refuse(400, "bad-request", "a query parameter given twice");
				if (originalOfText(path) !== null) return refuse(404, "file-not-found", "that revision of the space has no indexed file at that path");
				if (url.searchParams.get("original") === "true") {
					const type = originalType(path);
					if (type === null) return refuse(400, "bad-request", "only a PDF, Word or PowerPoint file in reference/ has an original: this file is its own text");
					if (!reaches(space.access, "edit")) return refuse(403, "not-permitted", "an original needs edit access: a read gives its text");
					const held = served(space)?.files.get(path);
					if (held === undefined) return refuse(404, "file-not-found", "that revision of the space has no indexed file at that path");
					const [, hash = "", bytes = "0"] = held.split(" ");
					return json(200, { space: space.id, path, revision: served(space)?.id ?? "", url: `${uploadsUrl}/${space.id}/${hash}`, expiresAt: stamp(now() + 300_000), bytes: Number(bytes), hash, mediaType: "application/octet-stream" } satisfies OriginalLink);
				}
				const lineNumber = (name: string, absent: number): number => {
					const value = url.searchParams.get(name);
					if (value === null) return absent;
					return /^[0-9]+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_LINE_NUMBER ? Number(value) : Number.NaN;
				};
				const lineStart = lineNumber("lineStart", 1);
				const lineEnd = lineNumber("lineEnd", Number.POSITIVE_INFINITY);
				if (Number.isNaN(lineStart)) return refuse(400, "bad-request", "lineStart must be a line number from 1");
				if (Number.isNaN(lineEnd)) return refuse(400, "bad-request", "lineEnd must be a line number from 1");
				if (lineEnd < lineStart) return refuse(400, "bad-request", "lineEnd must not be before lineStart");
				const asked = url.searchParams.get("revision");
				if (asked !== null && !/^[1-9][0-9]{0,17}$/.test(asked)) return refuse(400, "bad-request", "revision must be one search returned");
				// Guidance files are read at the latest revision, everything else at the served one (LOG.md 15:25, item 7). An older revision answers only for a file that has not changed since (decided 3 November, "No old revision is kept once the new file is indexed").
				const latest = GUIDANCE_FILES.has(path) ? head(space) : served(space);
				if (!latest) return refuse(409, "indexing", "the space has no indexed revision yet");
				const then = asked === null ? latest : space.revisions.find((candidate) => candidate.id === asked);
				const changed = () => refuse(409, "changed", "the file has changed since that revision, or the revision no longer exists: search again");
				if (!then) return changed();
				if (Number(then.id) > Number(latest.id)) return refuse(409, "indexing", "that revision is still being indexed: try again shortly");
				// An original reads as its text.
				const textPath = originalType(path) === null ? path : `${path}.md`;
				const text = latest.files.get(textPath);
				if (then.files.get(textPath) !== text) return changed();
				const dates = latest.dates.get(path);
				if (text === undefined || !dates) return refuse(404, "file-not-found", "that revision of the space has no indexed file at that path");
				const lines = text.split("\n");
				const slice = lines.slice(lineStart - 1, Math.min(lineEnd, lineStart - 1 + MAX_READ_LINES));
				const lastLine = lineStart - 1 + slice.length;
				return json(200, {
					space: space.id,
					path,
					revision: then.id,
					lineStart,
					lineEnd: lastLine,
					totalLines: lines.length,
					truncated: Math.min(lineEnd, lines.length) > lastLine,
					...dates,
					...(textPath === path ? {} : { converted: latest.dates.get(textPath)?.updated ?? dates.updated }),
					text: slice.join("\n"),
				} satisfies FileText);
			}
			if (method === "PUT") {
				// Nobody writes to managed/, at any level; a guidance file at the root, or anything under inbox/ or reference/; a new note or document needs contribute, anything else edit.
				if (isManaged(path)) return refuse(403, "not-permitted", "sleep alone writes managed notes: to correct one, save a note to the inbox and sleep files the correction");
				if (originalOfText(path) !== null) return refuse(403, "not-permitted", TEXT_IS_FOLDS);
				if (!writable(path)) return refuse(400, "bad-request", "a space's files are its guidance files at the root and everything under inbox/ and reference/");
				if (!space.memory && needsMemory(path)) return refuse(409, "memory-off", NO_NOTES);
				if (path.startsWith("inbox/") && /\.(pdf|docx|pptx)$/i.test(path)) {
					return refuse(415, "unsupported-type", "the inbox holds only notes: an original (PDF, Word or PowerPoint) goes to reference/");
				}
				const isNew = !head(space).files.has(path) && /^(inbox|reference)\//.test(path);
				if (!reaches(space.access, isNew ? "contribute" : "edit")) return forbidden(isNew ? "contribute" : "edit");
				const body = strictBody<WriteFile>(await readJson(request), ["text"], ["ifRevision"], ["confirm"]);
				if (!body) return refuse(400, "bad-request", "the body must be { text, ifRevision? }");
				if (new TextEncoder().encode(body.text).length > MAX_FILE_BYTES) return refuse(413, "too-large", "a file's text is at most 1 MiB");
				const tooLong = longLine(body.text);
				if (tooLong) return tooLong;
				if (!body.confirm && path.startsWith("inbox/") && LIKELY_CREDENTIAL.test(body.text)) return refuse(400, "holds-credential", HOLDS_CREDENTIAL);
				// Refused only when this file changed after the revision the writer read, so a person's own note saved a moment earlier does not refuse their next edit.
				if (body.ifRevision !== undefined) {
					const then = space.revisions.find((revision) => revision.id === body.ifRevision);
					if (!then || then.files.get(path) !== head(space).files.get(path)) {
						return refuse(409, "changed", "the file changed after that revision");
					}
				}
				// The same text again changes nothing and answers the current revision.
				if (head(space).files.get(path) === body.text) return json(200, { revision: head(space).id } satisfies Revised);
				const revision = commit(space, (files) => files.set(path, body.text));
				return json(200, { revision } satisfies Revised);
			}
			if (method === "DELETE") {
				if (originalOfText(path) !== null) return refuse(403, "not-permitted", TEXT_IS_FOLDS);
				const asked = url.searchParams.get("purge");
				if (asked !== null && asked !== "true" && asked !== "false") return refuse(400, "bad-request", "purge must be true or false");
				const purge = asked === "true" || isManaged(path);
				if (isManaged(path)) {
					if (!reaches(space.access, "admin")) {
						return refuse(403, "not-permitted", "only an admin can delete a managed note: to correct one, save a note to the inbox and sleep files the correction");
					}
				} else {
					if (!writable(path)) return refuse(400, "bad-request", "a space's files are its guidance files at the root and everything under inbox/ and reference/");
					if (purge && !reaches(space.access, "admin")) return refuse(403, "not-permitted", "only an admin can delete a file for good: an editor's delete keeps its last version for 30 days");
					if (!reaches(space.access, "edit")) return forbidden("edit");
				}
				if (UNDELETABLE_FILES.has(path)) return refuse(400, "bad-request", "a space's guidance files are edited, never deleted");
				const holds = head(space).files.has(path);
				if (!holds && !(purge && space.deleted.has(path))) return refuse(404, "file-not-found", "the space has no file at that path");
				const ifRevision = url.searchParams.get("ifRevision");
				if (ifRevision !== null) {
					const then = space.revisions.find((revision) => revision.id === ifRevision);
					if (!then || then.files.get(path) !== head(space).files.get(path)) return refuse(409, "changed", "the file changed after that revision");
				}
				// An original goes with its text, in the same commit.
				const leaving = originalType(path) === null ? [path] : [path, `${path}.md`];
				const revision = commit(space, (files) => {
					for (const gone of leaving) files.delete(gone);
				});
				space.conversions.delete(path);
				if (purge) {
					for (const gone of leaving) {
						space.previous.delete(gone);
						space.deleted.delete(gone);
					}
				}
				return json(200, { revision } satisfies Revised);
			}
		}

		return refuse(400, "bad-request", "that route is not served here");
	}

	return {
		handle: route,
		finishIndexing: () => {
			for (const space of spaces.values()) {
				space.indexedAt = 0;
				settle(space);
			}
		},
		headFiles: (id) => {
			const space = spaces.get(id);
			return space ? Object.fromEntries(head(space).files) : undefined;
		},
		fileNote: (id, path) => {
			const space = spaces.get(id);
			if (!space) return;
			commit(space, (files) => files.delete(path));
			const left = space.deleted.get(path);
			if (left) left.filed = true;
		},
	};
}
