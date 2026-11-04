/**
 * Which of a space's files are its notes, and whether one is safe to write into a vault. The vault is a space's `inbox/` and `managed/` and nothing else (decided 3 November, "A memory space has three folders"), so `reference/` and the guidance files never come here.
 *
 * A path is hostile input. Other people write to a shared space, and a file that reached a vault's `.obsidian/` would run as code, so a path is checked here as well as at Fold's door.
 */

/** fold-store's INBOX and MANAGED. */
export const NOTE_FOLDERS = ["inbox/", "managed/"] as const;
/** fold-store's NOTE_EXTENSIONS. */
export const NOTE_EXTENSIONS: readonly string[] = ["md", "markdown", "mdx"];

/** What Windows or Obsidian refuses in a name, and characters that make a name show as something it is not. Control characters are checked by their code, below. */
const UNSAFE_CHARACTERS = /[\\/:*?"<>|‪-‮⁦-⁩]/;
/** A C0 control character or DEL. */
const hasControlCharacter = (text: string) =>
	[...text].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
/** Names Windows keeps for itself, whatever follows the first dot. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_SEGMENT_BYTES = 255;

const encoder = new TextEncoder();

/** A path as Obsidian's `normalizePath` writes it to disk, beyond slashes: two kinds of non-breaking space become spaces, and accents take one form. A path is judged in this form, since this is what it becomes. */
export function localForm(path: string): string {
	return path.replace(/[\u00a0\u202f]/g, " ").normalize("NFC");
}

export function isNote(path: string): boolean {
	if (!NOTE_FOLDERS.some((folder) => path.startsWith(folder))) return false;
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 && NOTE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function isSafeSegment(segment: string): boolean {
	if (segment === "" || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ")) return false;
	if (UNSAFE_CHARACTERS.test(segment) || hasControlCharacter(segment)) return false;
	if (RESERVED_NAME.test(segment.split(".")[0] ?? "")) return false;
	return encoder.encode(segment).length <= MAX_SEGMENT_BYTES;
}

/** Whether a note's path can be written as it stands, on any system a vault may be opened on, and stay inside the note folders. */
export function isSafe(path: string): boolean {
	const local = localForm(path);
	return isNote(local) && local.split("/").every(isSafeSegment);
}

/** How a path compares on a disk that ignores case or how an accent is written: two paths with one key would overwrite each other there. */
export function collisionKey(path: string): string {
	return localForm(path).toLowerCase();
}

/** The folders a path sits in below its note folder, each as its collision key and as spelt on disk, for two notes that would need one place on some disk. */
export function foldersOf(path: string): [key: string, spelt: string][] {
	const segments = localForm(path).split("/");
	return segments.slice(1, -1).map((_, depth) => {
		const spelt = segments.slice(0, depth + 2).join("/");
		return [spelt.toLowerCase(), spelt];
	});
}

/** A note's bytes as Obsidian writes them back once it has merely opened the note: no byte order mark, and every line ending a line feed. That is not an edit, and must not be taken for one. */
export function asOpened(bytes: Uint8Array): Uint8Array {
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
	return encoder.encode(text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n"));
}

/** Where a person's edit of a note goes when Fold's version replaces it. */
export function editCopyPath(path: string, attempt: number): string {
	const dot = path.lastIndexOf(".");
	return `${path.slice(0, dot)} (local edit${attempt > 1 ? ` ${attempt}` : ""})${path.slice(dot)}`;
}
