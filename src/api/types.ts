/**
 * Fold's HTTP API as the web app reads it: the table in planning/memory-spaces-first/README.md, which the spaces lane owns, and the search and read answers fold-query serves (crates/fold-search/src/lib.rs and crates/fold-query/src/read.rs). A change there is posted in that round's LOG.md first and lands here. The mock in ui/mock/api.ts implements these same types, so the two cannot drift apart silently.
 */

import type { SkillName } from "./skills.ts";

/** A person's level on a space (section 06), lowest first. */
export const ACCESS_LEVELS = ["read", "contribute", "edit", "admin"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

/** Whether `held` reaches `needed`. */
export function reaches(held: Access, needed: Access): boolean {
	return ACCESS_LEVELS.indexOf(held) >= ACCESS_LEVELS.indexOf(needed);
}

/** An organisation or a team as the platform names it. */
export interface Named {
	id: string;
	name: string;
}

/** `GET /v1/spaces`, query part, as the spaces lane refined it (LOG.md 15:25, item 3). `summary` is the first sentence of `OVERVIEW.md`; `via` says how the person holds their access. */
export interface SpaceSummary {
	id: string;
	title: string;
	summary: string;
	organization: Named;
	access: Access;
	via: "owner" | "direct" | "team";
	team?: Named;
	state: SpaceState;
	revision: string | null;
}
export interface SpaceList {
	count: number;
	spaces: SpaceSummary[];
}

/** `POST /v1/spaces`, control part: Fold writes `PURPOSE.md`, `OVERVIEW.md` and `SAVING.md` and registers `space:<id>` with the creator. The API lets a token bound to one organisation leave `organization` out; the web app's token never is, so here it is always sent. */
export interface CreateSpace {
	organization: string;
	title: string;
	purpose: string;
	overview?: string;
	saving?: string;
	/** The `memory` switch, on unless this says otherwise. Off, a space is reference alone, with no notes and no sleep, and `saving` is refused. */
	memory?: boolean;
}
export interface SpaceCreated {
	id: string;
	revision: string;
}

/** `DELETE /v1/spaces/{space}`, control part, admin, a person only, with `{ confirm }` repeating the space's id: 202 once the space is gone from Fold, with 1p-platform's forgetting of it done or queued. Its data is erased in steps after that, and a 503 or 500 means asking again finishes it. */
export interface SpaceDeleting {
	id: string;
	state: "deleting";
}

/** `GET /v1/spaces/{space}`, query part (LOG.md 15:25, item 5). `revision` is the latest written, `servedRevision` the one search and read serve; the space is `indexing` until they match. Revisions are decimal strings. */
export type SpaceState = "ready" | "indexing";
export interface SpaceStatus {
	id: string;
	title: string;
	state: SpaceState;
	revision: string | null;
	servedRevision: string | null;
	embedder: Embedder;
	/** Whether search blends a file's age into its ranking here. An admin sets it, `PUT /v1/spaces/{space}/settings`, control part. */
	decay: boolean;
	/** Whether the space keeps notes and sleep files them, or is reference alone. */
	memory: boolean;
	/** The revision Fold has stopped trying to index, having tried again for days. Only here when that has happened. */
	indexingStuck?: string;
	/** Originals on their way in, and those that could not come, newest first; left out when there are none, or for someone who only reads. */
	conversions?: Conversion[];
	/** A repository's space: where it syncs from and what its last sync did (fold-query's `SyncView`). Only such a space has one. */
	sync?: SyncView;
}

/** What a status says of a repository's sync. */
export interface SyncView {
	provider: "github";
	/** `owner/name`. */
	repository: string;
	branch: string;
	/** Whether an admin has connected the space through Fold's GitHub App: it is then read through the App's installation, private or not, and hears each push. */
	connected: boolean;
	state: "never" | "synced" | "catching-up" | "failed";
	commit?: string;
	syncedAt?: string;
	failure?: { code: string; detail: string; at: string };
	skippedCount: number;
}

/** `POST /v1/spaces/{space}/github/connect`, control part, an admin's: GitHub's two pages, each carrying a `state` that is this person's and this space's for half an hour. */
export interface GitHubLinks {
	/** The App's installation page. */
	installUrl: string;
	/** Signing in to the App alone, for a repository it is already installed on. */
	authorizeUrl: string;
	expiresAt: string;
}

/** What GitHub sent the person back to `/github/setup` with, passed on to `POST /v1/github/setup`, control part. */
export interface GitHubSetup {
	state: string;
	code?: string;
	installationId?: number;
	setupAction?: "install" | "update" | "request";
}
export interface GitHubConnected {
	space: string;
	repository: string;
	/** `requested` when an owner of the repository's account must approve the installation first. */
	state: "connected" | "requested";
}

/** An upload between its commit and its revision, or why it never got one (fold-query's `ConversionView`). */
export interface Conversion {
	path: string;
	state: "converting" | "failed";
	/** A failure's stable code. */
	reason?: string;
	/** A failure's fixed sentence. */
	detail?: string;
	at: string;
}

/** The model a space's vectors were made with (fold-store's EmbedderName). */
export interface Embedder {
	id: string;
	version: string;
}

/** `GET /v1/spaces/{space}/guide`, query part; never `PURPOSE.md`. */
export interface SpaceGuide {
	overview: string;
	saving: string;
	access: Access;
	/** Whether the space takes notes at all. */
	memory: boolean;
	/** The skill an agent follows to use the space, named rather than embedded, with its MCP resource. */
	skill: { name: SkillName; resource: string };
}

/** `GET /v1/spaces/{space}/files?prefix=`, query part. */
export interface FileEntry {
	path: string;
	bytes: number;
	/** SHA-256 of the file's bytes, in lower-case hex. Null for a file that is never served this way: a guidance file, `system/`, or one the index skipped. */
	hash: string | null;
	indexed: boolean;
	/** A restore has an earlier version of this file to put back. */
	hasPrevious: boolean;
	/** That version is a note sleep filed, so only an admin can put it back. */
	previousFiled: boolean;
	/** What it is, for an original kept beside its text. Its `hash` is null for anyone short of edit. */
	original?: OriginalType;
}
/** A file that has left the space and whose last version stays, for a restore. */
export interface DeletedEntry {
	path: string;
	deletedAt: string;
	/** When its last version goes. */
	keptUntil: string | null;
	/** Sleep filed it, so only an admin can bring it back. */
	filed: boolean;
}
export interface FileList {
	revision: string | null;
	files: FileEntry[];
	deleted: DeletedEntry[];
}

/** `GET /v1/spaces/{space}/files/{path}?lineStart=&lineEnd=&revision=`, query part: a file's text by line range, from the revision the space serves unless asked for another. Both lines are 1-based, inclusive and optional. */
export interface FileText {
	space: string;
	path: string;
	revision: string;
	lineStart: number;
	/** The last line returned; one before `lineStart` when none is. */
	lineEnd: number;
	totalLines: number;
	/** Lines of the range were left out to keep the answer small; read on from `lineEnd + 1`. */
	truncated: boolean;
	created: string;
	updated: string;
	/** When this text was converted from its original. Only an original has one. */
	converted?: string;
	text: string;
}
/** The most lines one read returns (fold-query's MAX_READ_LINES). */
export const MAX_READ_LINES = 2_000;

/** `GET /v1/spaces/{space}/content/{path}?revision=`, query part (LOG.md 21:35): a file exactly as it is stored, for whoever holds a copy of it, as this app's editor does. The body is the file, not JSON; a refusal is JSON as everywhere else. */
export interface FileContent {
	text: string;
	/** From the answer's `Fold-Revision` header; a save passes it back as `ifRevision`. */
	revision: string;
	/** From the answer's `Fold-Hash` header: SHA-256 of the file's bytes, the one the file list gives, so a client can check what it read. Null if the header did not reach this client. */
	hash: string | null;
}
export const REVISION_HEADER = "fold-revision";
export const HASH_HEADER = "fold-hash";
/** The largest file one content read answers (fold-query's MAX_CONTENT_BYTES). */
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/** `POST /v1/spaces/{space}/search`, query part. With no `minScore`, the space's embedder's own floor applies; any field not named here is refused. */
export interface SearchRequest {
	query: string;
	limit: number;
	/** From -1 to 1. Overrides the embedder's floor, 0 included. */
	minScore?: number;
	/** `false` ranks by similarity alone. Left out, the space's setting decides; `true` cannot turn on what the space has turned off. */
	decay?: boolean;
}
/** fold-query's limits: a query up to 2,000 characters, 1 to 20 results. */
export const MAX_QUERY_CHARS = 2_000;
export const MAX_SEARCH_LIMIT = 20;
/** A result, in the order the API ranks them, at most 3 of a file while other files qualify (fold-query's Hit). `score` is raw similarity, which the order need not follow. */
export interface SearchHit {
	path: string;
	title: string;
	summary: string;
	lineStart: number;
	lineEnd: number;
	score: number;
	revision: string;
	/** When the file was created and last changed, RFC 3339 in UTC. */
	created: string;
	updated: string;
	/** How much of its age the file has kept, from the embedder's floor to 1. A search ranked by similarity alone has none. */
	strength?: number;
	/** The hit came from the file's own summary and stands for the whole file: its lines are its first chunk's. */
	wholeFile?: boolean;
	related: SearchHit[];
	/** What this result's sections link to and what links to them, beside `related` and outside `limit`; empty on a related section. */
	linked: LinkedSection[];
}
/** A section a result is linked to (fold-search's `Linked`). It has no score, since it was not compared with the query. */
export interface LinkedSection {
	path: string;
	lineStart: number;
	lineEnd: number;
	title: string;
	why: "wikilink" | "backlink" | "similar";
	/** The sentence written beside the link, where there is one. */
	reason?: string;
}
/** The embedder that answered a search, and its two scores, whatever this search sent (fold-query's SearchEmbedder): `minScore`, the floor a search with no `minScore` keeps results from, and `goodScore`, from which a result is usually what was asked for. */
export interface SearchEmbedder extends Embedder {
	minScore: number;
	goodScore: number;
}
export interface SearchResults {
	space: string;
	revision: string;
	embedder: SearchEmbedder;
	results: SearchHit[];
}

/** `POST /v1/spaces/{space}/notes`, control part, contribute: a new note in `inbox/`. */
export interface NewNote {
	text: string;
	title?: string;
	/** Stores a note the API just warned holds a likely credential. */
	confirm?: boolean;
}
export interface NoteSaved {
	path: string;
	revision: string;
}

/** `PUT /v1/spaces/{space}/files/{path}`, control part, edit: a small write, committed at once. */
export interface WriteFile {
	text: string;
	ifRevision?: string;
	/** Stores a note the API just warned holds a likely credential. */
	confirm?: boolean;
	/** Keeps no previous version: what the file held goes for good, with no undo. Needs edit. */
	scrub?: boolean;
}
/** `POST /v1/spaces/{space}/restore/{path}`, at edit: puts back the file's previous version, or a deleted file's last, as an ordinary write. */
export interface RestoreFile {
	ifRevision?: string;
	/** Stores a note the API just warned holds a likely credential. */
	confirm?: boolean;
}
/** The answer of `PUT`, `DELETE` and a restore. */
export interface Revised {
	revision: string;
}

/** `POST /v1/spaces/{space}/uploads`, control part, contribute: a short-lived link for an original, whose signature fixes where it goes, its size and its SHA-256. */
export interface NewUpload {
	path: string;
	bytes: number;
	sha256: string;
}
export interface UploadLink {
	upload: string;
	url: string;
	method: "PUT";
	/** To send with the file: a browser sets its length itself. */
	headers: Record<string, string>;
	expiresAt: string;
}
/** `POST /v1/spaces/{space}/uploads/{upload}`, control part: what was sent, committed. A write's level applies, and the answer is 202: the space's status says what becomes of it. */
export interface CommitUpload extends NewUpload {
	ifRevision?: string;
}
/** The answer of a commit, and of a restore of an original. */
export interface Converting {
	path: string;
	state: "converting";
}
/** `GET /v1/spaces/{space}/files/{path}?original=true`, query part, edit: a short-lived link to an original as it was uploaded (fold-query's `OriginalLink`). */
export interface OriginalLink {
	space: string;
	path: string;
	revision: string;
	url: string;
	expiresAt: string;
	bytes: number;
	hash: string;
	mediaType: string;
}

/** The types Fold converts, and what a person calls each (fold-store's `OriginalKind`). */
export const ORIGINAL_TYPES = { pdf: "PDF", docx: "Word", pptx: "PowerPoint" } as const;
export type OriginalType = keyof typeof ORIGINAL_TYPES;
/** The largest original, in decimal as a person reads it (fold-store's `MAX_ORIGINAL_BYTES`). */
export const MAX_ORIGINAL_BYTES = 80_000_000;
/** The largest text a write takes (fold-door's `MAX_FILE_BYTES`). */
export const MAX_FILE_BYTES = 1024 * 1024;
/** What a space takes as text, by extension (fold-door's `TEXT_EXTENSIONS`), which a parity test reads. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	"md", "markdown", "mdx", "txt", "text", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml",
	"rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp",
	"hh", "cs", "rb", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "css", "scss", "sass", "less", "lua", "pl", "r",
	"scala", "clj", "ex", "exs", "erl", "hs", "ml", "fs", "dart", "vue", "svelte", "graphql", "gql", "proto", "tf",
]);

/** A path's last extension, lower-cased, if it has one that is not the whole name (fold-store's `FilePath::extension`). */
export function extensionOf(path: string): string | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot + 1 < name.length ? name.slice(dot + 1).toLowerCase() : null;
}

/** An original's type, if a file at this path is one: only `reference/` holds them (fold-store's `original_kind`). */
export function originalType(path: string): OriginalType | null {
	const extension = extensionOf(path);
	return path.startsWith("reference/") && extension !== null && extension in ORIGINAL_TYPES ? (extension as OriginalType) : null;
}

/** Every refusal, in the platform's shape (section 05's codes). */
export interface ApiErrorBody {
	error: string;
	detail: string;
}

/** The codes the app treats differently; any other code is shown by its fixed sentence. */
export const ERROR_CODES = {
	unauthorised: "unauthorised",
	notFound: "not-found",
	fileNotFound: "file-not-found",
	changed: "changed",
	indexing: "indexing",
	accessUnavailable: "access-unavailable",
	identityUnavailable: "identity-unavailable",
	/** A token's scope or a person's level does not allow the call (LOG.md 15:25, item 2). */
	notPermitted: "not-permitted",
	unsupportedType: "unsupported-type",
	tooLarge: "too-large",
	/** A write holds a line over fold-control's limit; the sentence names the line. */
	lineTooLong: "line-too-long",
	/** A note holds a likely credential, and nothing was stored: sending it again with `confirm` stores it. */
	holdsCredential: "holds-credential", // secret-scan-ok: an error code, not a secret
	/** The space's `memory` switch is off, so it takes no notes. */
	memoryOff: "memory-off",
} as const;

/** When sleep runs in a space (`GET` and `PUT /v1/spaces/{space}/sleep`; the `PUT` is an admin's, the `GET` a contributor's). Whether it runs at all is the `memory` switch. */
export interface SleepSettings {
	/** How many notes waiting wake it. */
	notes: number;
	/** How many hours the oldest note may wait. */
	hours: number;
}

export type SleepRunStatus = "running" | "done" | "paused" | "failed" | "abandoned";

/** One run's minimal record (fold-store's RunRecord): times in seconds since 1970, tokens as the provider reported them. */
export interface SleepRun {
	id: string;
	startedAt: number;
	finishedAt: number | null;
	status: SleepRunStatus;
	reason: string | null;
	notesFiled: number;
	notesSetAside: number;
	batches: number;
	conflicts: number;
	modelCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Whether it ended with a consolidation, inside its ingest: left out when it did not. */
	consolidated?: boolean;
	/** Whether it nominated an evolution: left out when it did not. */
	nominated?: boolean;
}

/** What kind of change sleep nominates for evolve (fold-store's NominationKind). */
export type NominationKind = "categories" | "filing" | "saving" | "overview" | "purpose";

/** A change sleep has judged the space needs, as typed data (fold-store's Nomination): evolve takes it up once several runs across several days have made it. */
export interface Nomination {
	kind: NominationKind;
	paths: string[];
	evidence: string[];
	firstSeen: number;
	lastSeen: number;
	runs: number;
}

/** One evolve session's record (fold-store's EvolveRecord): what it was started for, what it changed and what it suggests, with tokens as the provider reported them. */
export interface EvolveSession {
	id: string;
	startedAt: number;
	finishedAt: number | null;
	status: SleepRunStatus;
	reason: string | null;
	kind: NominationKind;
	paths: string[];
	/** The guidance files it changed. */
	changed: string[];
	notesMoved: number;
	/** A change it suggests to PURPOSE.md, for the owner: never made. */
	suggestion: string | null;
	searches: number;
	reads: number;
	modelCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** A note sleep could not file: it stays in the inbox, and changing it gives it another try. */
export interface SleepSetAside {
	path: string;
	reason: string;
	/** When it was set aside; null for a note set aside by its size alone. */
	at: number | null;
}

/** `PUT /v1/spaces/{space}/settings`, control part, admin: a space's switches, each sent on its own, and answered as they now stand. */
export interface SpaceSettings {
	decay: boolean;
	memory: boolean;
}

/** `GET /v1/spaces/{space}/sleep`, query part, contribute: runs newest first. */
export interface SleepView {
	settings: SleepSettings;
	waiting: number;
	runs: SleepRun[];
	setAside: SleepSetAside[];
	/** Evolve's last sessions, newest first. */
	evolutions: EvolveSession[];
	/** The changes sleep has nominated that evolve has not taken up. */
	nominations: Nomination[];
}

/** Guidance files: written for agents and people, read through the guide or directly at the latest revision, and never indexed, so the file list always marks them `indexed: false` (LOG.md 15:25, items 6 and 7). */
export const GUIDANCE_FILES: ReadonlySet<string> = new Set(["PURPOSE.md", "OVERVIEW.md", "SAVING.md", "SLEEP.md", "DREAMS.md"]);
/** Sleep's tracker: sleep and evolve write it, and an admin may only scrub whole lines out of it (decided 5 November, "An admin may scrub DREAMS.md"). */
export const DREAMS_FILE = "DREAMS.md";
/** The guidance files a space cannot lose (LOG.md 15:25, item 9). */
export const UNDELETABLE_FILES: ReadonlySet<string> = new Set(["PURPOSE.md", "OVERVIEW.md", "SAVING.md"]);

/** What a space with its `memory` switch off does not show or take (fold-store's `needs_memory`): its notes, and the guidance about them. */
export function needsMemory(path: string): boolean {
	return path.startsWith("inbox/") || path.startsWith("managed/") || path === "SAVING.md" || path === "SLEEP.md" || path === "DREAMS.md";
}

/** Notes sleep files and keeps in order. Anyone with edit changes, deletes or restores one like any file (decided 4 November, "Editors may change any file"); adding memory still goes through the inbox. */
export function isManaged(path: string): boolean {
	return path.startsWith("managed/");
}

/** The three files every space starts with, and what each is for (section 02, "A space's own files"). */
export const SPACE_FILES = [
	{
		path: "PURPOSE.md",
		label: "Purpose",
		help: "Why the space exists and what belongs in it. Its first heading is the space's title.",
	},
	{
		path: "OVERVIEW.md",
		label: "Overview",
		help: "What an agent will find here, never a map of folders. Its first sentence is what lists and results show.",
	},
	{
		path: "SAVING.md",
		label: "Saving guidance",
		help: "What is worth saving, and what a note should contain. Agents read it before they save.",
	},
] as const;
