/**
 * What the plugin keeps between sessions, and where. Saved data sits in a file inside the vault, which can be synced, shared, or come from someone else, so nothing in it is taken on trust. What a token is used for is not in it at all: the address, the secret's name and the space stay on this device, in Obsidian's per-vault local storage, so a vault can never send a person's secrets to a host of its choosing, nor have their token fetch a space they did not choose.
 */
import { NOTHING_YET, type SyncState } from "./sync";

export interface Saved {
	intervalMinutes: number;
	sync: SyncState;
}

export interface Connection {
	/** Fold's address as the person entered it: its web app's, or, as 0.1 asked for, its query part's. */
	queryUrl: string;
	/** The name of the token in Obsidian's secret storage, never the token. */
	secretName: string;
	space: string;
	/** Whether to send the person's edits and new inbox notes to Fold. Kept here, so a vault can never turn it on. */
	sendEdits: boolean;
}

export const DEFAULT_INTERVAL_MINUTES = 5;
/** A day. A timer's delay is a 32-bit number of milliseconds, and a larger one fires without end. */
const MAX_INTERVAL_MINUTES = 1_440;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseSync(value: unknown): SyncState {
	if (!isRecord(value) || !isRecord(value.files)) return NOTHING_YET;
	const { space, revision, files } = value;
	const opened = isRecord(value.opened) ? value.opened : {};
	const refused = isRecord(value.refused) ? value.refused : {};
	if ((space !== null && typeof space !== "string") || (revision !== null && typeof revision !== "string")) return NOTHING_YET;
	if (![...Object.values(files), ...Object.values(opened)].every((hash) => typeof hash === "string")) return NOTHING_YET;
	// What Fold refused only ever holds a note back, so one that cannot be read is simply forgotten.
	const refusedHashes = Object.entries(refused).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return { space, revision, files: files as Record<string, string>, opened: opened as Record<string, string>, refused: Object.fromEntries(refusedHashes) };
}

export function parseSaved(data: unknown): Saved {
	const saved = isRecord(data) ? data : {};
	const minutes = saved.intervalMinutes;
	return {
		intervalMinutes: typeof minutes === "number" && minutes >= 1 && minutes <= MAX_INTERVAL_MINUTES ? minutes : DEFAULT_INTERVAL_MINUTES,
		sync: parseSync(saved.sync),
	};
}

export function parseConnection(data: unknown): Connection {
	const saved = isRecord(data) ? data : {};
	return {
		queryUrl: typeof saved.queryUrl === "string" ? saved.queryUrl : "",
		secretName: typeof saved.secretName === "string" ? saved.secretName : "",
		space: typeof saved.space === "string" ? saved.space : "",
		sendEdits: saved.sendEdits === true,
	};
}

/** What a person changed in this vault while sending was on, by path, with when, kept on this device until it is sent. */
export function parseOutbox(data: unknown): Record<string, number> {
	if (!isRecord(data)) return {};
	return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}
