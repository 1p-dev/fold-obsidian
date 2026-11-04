import {
	type ApiErrorBody,
	type CommitUpload,
	type Converting,
	type CreateSpace,
	type FileContent,
	type FileList,
	type FileText,
	HASH_HEADER,
	type NewNote,
	type NewUpload,
	type NoteSaved,
	type OriginalLink,
	REVISION_HEADER,
	type RestoreFile,
	type Revised,
	type SearchRequest,
	type SearchResults,
	type SleepSettings,
	type SleepView,
	type SpaceCreated,
	type SpaceGuide,
	type SpaceList,
	type SpaceSettings,
	type SpaceStatus,
	type UploadLink,
	type WriteFile,
} from "./types";

/** A refusal from Fold, with its code and fixed sentence; status 0 when Fold could not be reached. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: string,
	) {
		super(detail);
	}
}

export interface ApiClientOptions {
	queryUrl: string;
	controlUrl: string;
	/** A current access token, or null when signed out. */
	token: () => Promise<string | null>;
	/** Called on a 401: answers true when a new token is worth one retry. */
	refresh: () => Promise<boolean>;
	/** How to reach Fold: the web app passes the browser's fetch, and the Obsidian plugin one over Obsidian's requestUrl. There is no default, so the plugin's bundle holds no call to fetch, which Obsidian's review flags. */
	fetch: typeof fetch;
}

/** A space's id as one path segment, and a file's path as its segments, so `/` stays a separator and nothing else does. */
function segment(value: string): string {
	return encodeURIComponent(value);
}
export function filePath(path: string): string {
	const segments = path.split("/");
	// Encoding leaves `.` and `..` as they are, and a URL collapses them: a path holding one, which a double-encoded link in a note can make, would reach another space's routes.
	if (segments.some((part) => part === "" || part === "." || part === "..")) {
		throw new ApiError(400, "bad-request", "the file path is not a path in a space");
	}
	return segments.map(segment).join("/");
}

const UNEXPECTED = "Fold did not answer as expected.";

function isErrorBody(body: unknown): body is ApiErrorBody {
	return typeof body === "object" && body !== null && typeof (body as ApiErrorBody).error === "string";
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Fold's HTTP API (planning/memory-spaces-first/README.md): reads go to the query part, writes to the control part, each with the person's bearer token. */
export function createApiClient(options: ApiClientOptions) {
	const fetchImpl = options.fetch;

	/** The response to a call that succeeded; anything else is thrown as a refusal. */
	async function send(base: string, method: string, path: string, body?: unknown, retried = false): Promise<Response> {
		const token = await options.token();
		if (!token) throw new ApiError(401, "unauthorised", "You are signed out.");
		let response: Response;
		try {
			response = await fetchImpl(`${base}${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new ApiError(0, "unreachable", "Fold could not be reached. Check your connection and try again.");
		}
		if (response.status === 401 && !retried && (await options.refresh())) {
			return send(base, method, path, body, true);
		}
		if (!response.ok) {
			const answer: unknown = await response.json().catch(() => undefined);
			if (isErrorBody(answer)) throw new ApiError(response.status, answer.error, answer.detail ?? "");
			throw new ApiError(response.status, "internal", UNEXPECTED);
		}
		return response;
	}

	async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
		const response = await send(base, method, path, body);
		return (await response.json().catch(() => undefined)) as T;
	}

	const query = <T>(method: string, path: string, body?: unknown) => call<T>(options.queryUrl, method, path, body);
	const control = <T>(method: string, path: string, body?: unknown) => call<T>(options.controlUrl, method, path, body);
	const space = (id: string) => `/v1/spaces/${segment(id)}`;

	return {
		listSpaces: () => query<SpaceList>("GET", "/v1/spaces"),
		createSpace: (body: CreateSpace) => control<SpaceCreated>("POST", "/v1/spaces", body),
		status: (id: string) => query<SpaceStatus>("GET", space(id)),
		guide: (id: string) => query<SpaceGuide>("GET", `${space(id)}/guide`),
		files: (id: string, prefix?: string) =>
			query<FileList>("GET", `${space(id)}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`),
		read: (id: string, path: string, range: { lineStart?: number; lineEnd?: number; revision?: string } = {}) => {
			const params = new URLSearchParams();
			if (range.lineStart) params.set("lineStart", String(range.lineStart));
			if (range.lineEnd) params.set("lineEnd", String(range.lineEnd));
			if (range.revision) params.set("revision", range.revision);
			const search = params.size > 0 ? `?${params}` : "";
			return query<FileText>("GET", `${space(id)}/files/${filePath(path)}${search}`);
		},
		/** A file exactly as it is stored. The bytes are decoded by hand: `response.text()` would strip a leading byte order mark, and text that is not UTF-8 is refused rather than shown and saved back damaged. */
		content: async (id: string, path: string): Promise<FileContent> => {
			const response = await send(options.queryUrl, "GET", `${space(id)}/content/${filePath(path)}`);
			const revision = response.headers.get(REVISION_HEADER);
			if (!revision) throw new ApiError(response.status, "internal", UNEXPECTED);
			try {
				return { revision, hash: response.headers.get(HASH_HEADER), text: new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(await response.arrayBuffer()) };
			} catch {
				throw new ApiError(response.status, "internal", UNEXPECTED);
			}
		},
		search: (id: string, body: SearchRequest) => query<SearchResults>("POST", `${space(id)}/search`, body),
		sleep: (id: string) => query<SleepView>("GET", `${space(id)}/sleep`),
		setSleep: (id: string, settings: SleepSettings) => control<SleepSettings>("PUT", `${space(id)}/sleep`, settings),
		setSettings: (id: string, settings: Partial<SpaceSettings>) => control<SpaceSettings>("PUT", `${space(id)}/settings`, settings),
		/** Every file of the space read again, at admin: answers the revision whose job does it, and the space says indexing until it is served. */
		reindex: (id: string) => control<Revised>("POST", `${space(id)}/reindex`),
		saveNote: (id: string, body: NewNote) => control<NoteSaved>("POST", `${space(id)}/notes`, body),
		writeFile: (id: string, path: string, body: WriteFile) => control<Revised>("PUT", `${space(id)}/files/${filePath(path)}`, body),
		/** `ifRevision` refuses the delete with `changed` when the file changed after that revision (spaces lane, LOG.md 15:45). `purge`, at admin, takes both versions at once, with no way back. */
		deleteFile: (id: string, path: string, options: { ifRevision?: string; purge?: boolean } = {}) => {
			const params = new URLSearchParams();
			if (options.ifRevision) params.set("ifRevision", options.ifRevision);
			if (options.purge) params.set("purge", "true");
			return control<Revised>("DELETE", `${space(id)}/files/${filePath(path)}${params.size > 0 ? `?${params}` : ""}`);
		},
		/** A file's previous version, put back: an ordinary write, or a conversion on its way for an original. */
		restoreFile: (id: string, path: string, body: RestoreFile) => control<Revised | Converting>("POST", `${space(id)}/restore/${filePath(path)}`, body),
		newUpload: (id: string, body: NewUpload) => control<UploadLink>("POST", `${space(id)}/uploads`, body),
		/** Sends an original straight to the store, past Fold, so it takes no bearer: the link's signature is the permission, and holds it to its size and its SHA-256. */
		sendUpload: async (link: UploadLink, file: Blob): Promise<void> => {
			let response: Response;
			try {
				response = await fetchImpl(link.url, { method: link.method, headers: link.headers, body: file });
			} catch {
				throw new ApiError(0, "unreachable", "Fold could not be reached. Check your connection and try again.");
			}
			if (!response.ok) throw new ApiError(response.status, "upload-refused", UNEXPECTED);
		},
		commitUpload: (id: string, upload: string, body: CommitUpload) => control<Converting>("POST", `${space(id)}/uploads/${segment(upload)}`, body),
		originalLink: (id: string, path: string) => query<OriginalLink>("GET", `${space(id)}/files/${filePath(path)}?original=true`),
	};
}
