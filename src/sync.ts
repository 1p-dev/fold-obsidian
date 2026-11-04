/**
 * One round of keeping a vault's copy of a space's notes: ask whether the space moved, list its files, take what changed, and put away what has gone. It runs against two small seams, so the tests drive every rule without Obsidian.
 *
 * What it promises: a vault holds one space, and a round for another changes nothing; bytes are checked against Fold's hash before they are written; a person's own file is never overwritten, and their edit of a note is kept beside it; nothing is taken away unless Fold answered with a whole list, a note that only moved is never missing, and a timer never empties a vault on its own; and a round that stops part way loses nothing, since what it did is kept and the rest is taken next time.
 */
import { ApiError, type ApiClient } from "./api/client";
import type { FileEntry, FileList } from "./api/types";
import { sha256 } from "./hash";
import { asOpened, collisionKey, editCopyPath, foldersOf, isNote, isSafe, localForm } from "./notes";

/** What the last round left: the space it was for, the revision it finished, and each note it holds, by path, with the hash of what Fold gave. */
export interface SyncState {
	space: string | null;
	revision: string | null;
	files: Record<string, string>;
	/** A note's hash once Obsidian has opened it, for the few notes where that differs from what Fold gave. */
	opened: Record<string, string>;
}
export const NOTHING_YET: SyncState = { space: null, revision: null, files: {}, opened: {} };

/** The vault, as far as a round needs it. */
export interface Store {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Uint8Array | null>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	/** Away to the person's trash, so it can be got back. */
	trash(path: string): Promise<void>;
}

export type Source = Pick<ApiClient, "status" | "files" | "content">;

export interface SyncOptions {
	space: string;
	/** A person asked: run whatever the revision says, so a note they deleted comes back, and take away however many notes Fold removed. */
	force?: boolean;
	stopped?: () => boolean;
	progress?: (done: number, total: number) => void;
	/** Called now and then during a long round, so a crash loses little. */
	checkpoint?: (state: SyncState) => Promise<void>;
}

export interface SyncReport {
	/** Whether the round asked for the list at all. */
	ran: boolean;
	/** How many notes the space's list held. None is an answer, not a fault: a space whose memory is off is reference alone. */
	notes: number;
	/** Everything the served revision holds is here or accounted for. */
	complete: boolean;
	written: number;
	trashed: number;
	/** Notes not yet served by search, which come in a later round. */
	waiting: number;
	/** Where a person's edit of a note was kept, as Fold's version replaced it. */
	editCopies: string[];
	/** Notes Fold removed that a person had edited, left in place. */
	keptEdited: string[];
	/** Notes that cannot come here: an unsafe name, a person's own file in the way, or too large. A later round tries again only if the note changes. */
	blocked: string[];
	/** Notes that failed this round and are tried again next time. */
	failed: string[];
	/** How many notes Fold removed that a timer's round will not take away by itself, since more went than remain. */
	heldRemovals: number;
	/** How many notes Fold removed that stay until a note on its way has settled. */
	removalsWaiting: number;
	/** What stopped the round, when Fold or the network did. */
	stoppedBy?: unknown;
}

const encoder = new TextEncoder();
const CHECKPOINT_EVERY = 25;
const HASH = /^[0-9a-f]{64}$/;
/** More removals than this, and more than the notes that remain, wait for a person to ask. */
const MANY_REMOVALS = 20;

const UNEXPECTED = "Fold did not answer as expected.";
/** A vault holds one space. Taking another's list for this one's would remove every note. */
export const OTHER_SPACE = new ApiError(409, "other-space", "This vault holds the notes of another space.");

/** A file's refusal that says something about that file alone. Any other, such as a refused token, stops the round. */
const FILE_REFUSALS = new Set(["file-not-found", "changed", "indexing", "internal"]);

/** A space's notes from its list. Anything not in the shape Fold promises is thrown, since a list that cannot be trusted must never decide what to take away. */
function notesOf(list: FileList | undefined): FileEntry[] {
	if (typeof list?.revision !== "string" || !Array.isArray(list.files)) throw new ApiError(200, "internal", UNEXPECTED);
	const notes: FileEntry[] = [];
	for (const file of list.files) {
		if (typeof file?.path !== "string") throw new ApiError(200, "internal", UNEXPECTED);
		if (!isNote(file.path)) continue;
		// Fold names no hash for a note the index skipped, which is not served and so simply waits. One that is served without a hash is not Fold's answer.
		const usable = typeof file.hash === "string" && HASH.test(file.hash);
		if (file.indexed ? !usable : file.hash !== null && !usable) throw new ApiError(200, "internal", UNEXPECTED);
		notes.push(file);
	}
	return notes;
}

export async function syncSpace(source: Source, store: Store, state: SyncState, options: SyncOptions): Promise<{ state: SyncState; report: SyncReport }> {
	const report: SyncReport = { ran: false, notes: 0, complete: false, written: 0, trashed: 0, waiting: 0, editCopies: [], keptEdited: [], blocked: [], failed: [], heldRemovals: 0, removalsWaiting: 0 };
	const holdsNotes = Object.keys(state.files).length > 0;
	if (holdsNotes && state.space !== options.space) {
		report.stoppedBy = OTHER_SPACE;
		return { state, report };
	}
	const finished = state.space === options.space ? state.revision : null;
	const files = { ...state.files };
	const opened = { ...state.opened };
	const kept = (revision: string | null) => ({ state: { space: options.space, revision, files, opened }, report });

	/** Records a note as held, with the form Obsidian will leave it in. */
	const hold = async (path: string, hash: string, bytes: Uint8Array): Promise<void> => {
		files[path] = hash;
		const asItOpens = await sha256(asOpened(bytes));
		if (asItOpens === hash) delete opened[path];
		else opened[path] = asItOpens;
	};
	/** Whether a file is still what Fold gave, allowing for what Obsidian does to a note by opening it. */
	const untouched = async (path: string, local: Uint8Array): Promise<boolean> => {
		if ((await sha256(local)) === files[path]) return true;
		return opened[path] !== undefined && (await sha256(asOpened(local))) === opened[path];
	};

	let served: string | null;
	let notes: FileEntry[];
	try {
		const status = await source.status(options.space);
		served = status?.servedRevision;
		if (served !== null && typeof served !== "string") throw new ApiError(200, "internal", UNEXPECTED);
		if (served === null || (served === finished && !options.force)) {
			report.complete = true;
			return kept(finished);
		}
		report.ran = true;
		notes = notesOf(await source.files(options.space));
		report.notes = notes.length;
	} catch (error) {
		report.stoppedBy = error;
		return kept(finished);
	}

	let settling = false;
	const listed = new Set<string>();
	/** Content a note that cannot come here holds: a file holding it stays. */
	const unsettled = new Set<string>();
	const unsettle = (file: FileEntry) => {
		if (file.hash) unsettled.add(file.hash);
	};
	const wanted: FileEntry[] = [];
	const seen = new Set<string>();
	/** Each folder's key, with the one way a note here spells it. */
	const folders = new Map<string, string>();
	const inList = new Set(notes.map((file) => file.path));
	const byLocalForm = new Map(notes.map((file) => [localForm(file.path), file.path]));
	// A note Fold only respelt, in a way the disk does not see, is the same file: what is known about it goes with it.
	for (const path of Object.keys(files)) {
		const respelt = byLocalForm.get(localForm(path));
		const hash = files[path];
		if (respelt === undefined || hash === undefined || inList.has(path) || files[respelt] !== undefined) continue;
		files[respelt] = hash;
		const asItOpens = opened[path];
		if (asItOpens !== undefined) opened[respelt] = asItOpens;
		delete files[path];
		delete opened[path];
	}
	// A folder this vault already holds keeps its spelling, so a newcomer spelling it differently is the one kept out, and the notes here carry on.
	for (const file of notes) {
		if (files[file.path] === undefined) continue;
		for (const [folder, spelt] of foldersOf(file.path)) folders.set(folder, spelt);
	}
	// Decided from the whole list first, so a file blocked here never reaches the disk.
	for (const file of notes) {
		listed.add(file.path);
		const key = collisionKey(file.path);
		const within = foldersOf(file.path);
		// One file, or a file where a folder must go, or one folder spelt two ways, are all one place on some disk.
		const clashes = seen.has(key) || folders.has(key) || within.some(([folder, spelt]) => seen.has(folder) || (folders.get(folder) ?? spelt) !== spelt);
		if (!isSafe(file.path) || clashes) {
			report.blocked.push(file.path);
			unsettle(file);
			continue;
		}
		seen.add(key);
		for (const [folder, spelt] of within) folders.set(folder, spelt);
		if (!file.indexed) {
			report.waiting += 1;
			// A note with a hash is on its way. One with none, which the index skipped, may never come, so it holds nothing back.
			if (file.hash !== null) settling = true;
			continue;
		}
		try {
			if (files[file.path] === file.hash && (await store.exists(file.path))) continue;
			// What is on disk may settle it with nothing read from Fold: the same bytes are simply taken as Fold's, and a person's own file stays where it is.
			const local = await store.read(file.path);
			if (local !== null) {
				if ((await sha256(local)) === file.hash) {
					await hold(file.path, file.hash, local);
					continue;
				}
				if (files[file.path] === undefined) {
					report.blocked.push(file.path);
					unsettle(file);
					continue;
				}
			}
			wanted.push(file);
		} catch {
			report.failed.push(file.path);
			unsettle(file);
		}
	}

	/** One note in from Fold. Its bytes are checked before anything on disk changes. */
	const bringIn = async (file: FileEntry): Promise<void> => {
		const content = await source.content(options.space, file.path);
		const bytes = encoder.encode(content.text);
		const hash = await sha256(bytes);
		if (hash !== content.hash) {
			report.failed.push(file.path);
			unsettle(file);
			return;
		}
		const local = await store.read(file.path);
		if (local !== null) {
			const localHash = await sha256(local);
			if (localHash === hash) {
				await hold(file.path, hash, local);
				return;
			}
			if (files[file.path] === undefined) {
				report.blocked.push(file.path);
				unsettle(file);
				return;
			}
			if (!(await untouched(file.path, local))) {
				let attempt = 1;
				while (await store.exists(editCopyPath(file.path, attempt))) attempt += 1;
				const copy = editCopyPath(file.path, attempt);
				await store.write(copy, local);
				report.editCopies.push(copy);
				// The edit is safe now: if the write below fails, the next round does not keep it a second time.
				await hold(file.path, localHash, local);
			}
		}
		await store.write(file.path, bytes);
		await hold(file.path, hash, bytes);
		report.written += 1;
	};

	let done = 0;
	for (const file of wanted) {
		if (options.stopped?.()) return kept(finished);
		try {
			await bringIn(file);
		} catch (error) {
			if (error instanceof ApiError && error.code === "too-large") {
				report.blocked.push(file.path);
				unsettle(file);
			} else if (!(error instanceof ApiError) || FILE_REFUSALS.has(error.code)) {
				report.failed.push(file.path);
				unsettle(file);
			} else {
				report.stoppedBy = error;
				return kept(finished);
			}
		}
		done += 1;
		options.progress?.(done, wanted.length);
		if (done % CHECKPOINT_EVERY === 0) await options.checkpoint?.({ space: options.space, revision: finished, files, opened });
	}

	const stillHeld = new Set(notes.map((file) => file.hash ?? ""));
	const removals: string[] = [];
	for (const path of Object.keys(files)) {
		if (listed.has(path)) continue;
		// Saved state sits in the vault, and a vault can come from anyone: it never decides what happens beyond the notes.
		if (!isSafe(path)) {
			delete files[path];
			delete opened[path];
		} else if (!unsettled.has(files[path] ?? "")) {
			removals.push(path);
		}
	}
	// A note on its way, or one that failed, may be where a note here moved to, and sleep changes a note's bytes when it files one, so nothing can tell. Nothing goes until they have settled, so a filed note is never missing. A failure can last, such as a file a person locked, so a person asking takes them away regardless.
	if (settling || (report.failed.length > 0 && !options.force)) {
		report.removalsWaiting = removals.length;
		return kept(finished);
	}
	const lost = removals.filter((path) => !stillHeld.has(files[path] ?? "")).length;
	// More gone than remain, and enough that it is no slip: compared with what is listed, so a poll after this one finds the same.
	if (!options.force && lost > MANY_REMOVALS && lost > notes.length) {
		report.heldRemovals = lost;
		return kept(finished);
	}
	for (const path of removals) {
		if (options.stopped?.()) return kept(finished);
		try {
			const local = await store.read(path);
			if (local !== null) {
				if (await untouched(path, local)) {
					await store.trash(path);
					report.trashed += 1;
				} else {
					report.keptEdited.push(path);
				}
			}
			delete files[path];
			delete opened[path];
		} catch {
			report.failed.push(path);
		}
	}

	report.complete = report.failed.length === 0;
	return kept(report.complete ? served : finished);
}
