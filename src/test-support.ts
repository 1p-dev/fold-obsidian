/** A vault and a Fold in memory, for the tests. */
import { ApiError } from "./api/client";
import type { FileEntry } from "./api/types";
import { sha256 } from "./hash";
import { localForm } from "./notes";
import type { Source, Store } from "./sync";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export class MemoryStore implements Store {
	readonly files = new Map<string, Uint8Array>();
	/** Everything done, in order. */
	readonly log: string[] = [];
	failWrites = false;
	/** Paths that cannot be written, or read, such as a locked file. */
	readonly locked = new Set<string>();
	readonly unreadable = new Set<string>();

	put(path: string, text: string): void {
		this.files.set(localForm(path), encoder.encode(text));
	}
	text(path: string): string | undefined {
		const bytes = this.files.get(localForm(path));
		return bytes && decoder.decode(bytes);
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(localForm(path));
	}
	async read(path: string): Promise<Uint8Array | null> {
		if (this.unreadable.has(path)) throw new Error("the file cannot be read");
		return this.files.get(localForm(path)) ?? null;
	}
	async write(path: string, bytes: Uint8Array): Promise<void> {
		if (this.failWrites || this.locked.has(path)) throw new Error("the disk refused");
		this.log.push(`write ${path}`);
		this.files.set(localForm(path), bytes);
	}
	async trash(path: string): Promise<void> {
		this.log.push(`trash ${path}`);
		this.files.delete(localForm(path));
	}
}

/** A Fold whose list and answers a test sets by hand, including ones the real one would never give. */
export class FakeFold implements Source {
	served: string | null = "1";
	notes: Record<string, string>;
	notIndexed = new Set<string>();
	/** What `files` answers instead of the list. */
	listAnswer: unknown;
	listRefusal: ApiError | undefined;
	/** A refusal for reading a path. */
	readRefusals = new Map<string, ApiError>();
	/** A hash for reading a path that does not match what it answers. */
	wrongHash = new Set<string>();
	readonly reads: string[] = [];
	statusCalls = 0;
	listCalls = 0;

	constructor(notes: Record<string, string>) {
		this.notes = notes;
	}

	status: Source["status"] = async () => {
		this.statusCalls += 1;
		return { id: "s", title: "S", state: "ready", revision: this.served, servedRevision: this.served, embedder: { id: "e", version: "1" }, decay: true, memory: true };
	};

	files: Source["files"] = async () => {
		this.listCalls += 1;
		if (this.listRefusal) throw this.listRefusal;
		if (this.listAnswer !== undefined) return this.listAnswer as Awaited<ReturnType<Source["files"]>>;
		const files: FileEntry[] = await Promise.all(
			Object.entries(this.notes).map(async ([path, text]) => ({
				path,
				bytes: encoder.encode(text).length,
				hash: await sha256(encoder.encode(text)),
				indexed: !this.notIndexed.has(path),
				hasPrevious: false,
				previousFiled: false,
			})),
		);
		return { revision: this.served, files, deleted: [] };
	};

	content: Source["content"] = async (_space, path) => {
		this.reads.push(path);
		const refusal = this.readRefusals.get(path);
		if (refusal) throw refusal;
		const text = this.notes[path];
		if (text === undefined) throw new ApiError(404, "file-not-found", "gone");
		const hash = this.wrongHash.has(path) ? "0".repeat(64) : await sha256(encoder.encode(text));
		return { text, revision: this.served ?? "1", hash };
	};
}

export const refusal = (code: string, status = 400) => new ApiError(status, code, "a fixed sentence");
