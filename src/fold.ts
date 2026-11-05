/**
 * Fold's API through the web app's own client, so there is one owner of its routes and refusals. Only the way out differs: Obsidian's `requestUrl`, which is not held to a browser's cross-origin rules and works on phones. The plugin reads, and writes only a person's edits and new inbox notes, when they have turned sending on.
 */
import { type ApiClient, ApiError, createApiClient } from "./api/client";

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** A write's JSON. The plugin sends nothing else. */
	body?: string;
	/** Answer a refusal rather than throw, so its body can be read. */
	throw: false;
}
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}
export type Http = (request: HttpRequest) => PromiseLike<HttpResponse>;

/** The statuses a Response may not have a body for. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** How long one call may take. `requestUrl` has no timeout of its own, and a call that never answered would stop every later round until Obsidian restarted. */
export const CALL_TIMEOUT_MS = 60_000;

function withinTimeout<T>(call: PromiseLike<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error("the call took too long")), CALL_TIMEOUT_MS);
		call.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error("the call failed", { cause: error }));
			},
		);
	});
}

/** `fetch` over Obsidian's `requestUrl`. The answer's body stays bytes, so a file's bytes arrive as they were sent. */
export function fetchOver(http: Http): typeof fetch {
	return async (input, init) => {
		const body = init?.body;
		// The client sends JSON text and nothing else; an upload's bytes would need a body this does not carry.
		if (body !== undefined && body !== null && typeof body !== "string") throw new Error("only a text body can be sent");
		const answer = await withinTimeout(
			http({
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				method: init?.method ?? "GET",
				headers: (init?.headers ?? {}) as Record<string, string>,
				...(typeof body === "string" ? { body } : {}),
				throw: false,
			}),
		);
		return new Response(NO_BODY.has(answer.status) ? null : answer.arrayBuffer, { status: answer.status, headers: answer.headers });
	};
}

/** The query address as the settings hold it, or null when it is not a plain https address: a bearer token never travels in the clear, nor to a host the address only appears to name. */
export function queryAddress(text: string): string | null {
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) return null;
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Fold's two parts: the query part, which reads, and the control part, which writes. Without the control part's address the plugin only reads. */
export interface Addresses {
	query: string;
	control: string | null;
}

/**
 * Fold's addresses from what a person entered. Fold's web app, the address people know, says both in its `/config.json`, read without the token. Anything else is taken as the query part's own address, as 0.1 asked for, and reads only. A network failure is thrown, since guessing then would point the token at the web app.
 */
export async function resolveAddresses(text: string, http: Http): Promise<Addresses | null> {
	const base = queryAddress(text);
	if (!base) return null;
	let answer: HttpResponse;
	try {
		answer = await withinTimeout(http({ url: `${base}/config.json`, method: "GET", headers: {}, throw: false }));
	} catch {
		throw new ApiError(0, "unreachable", "Fold could not be reached. Check your connection and try again.");
	}
	if (answer.status === 200) {
		try {
			const config: unknown = JSON.parse(new TextDecoder().decode(answer.arrayBuffer));
			if (typeof config === "object" && config !== null) {
				const { queryUrl, controlUrl } = config as Record<string, unknown>;
				const query = typeof queryUrl === "string" ? queryAddress(queryUrl) : null;
				const control = typeof controlUrl === "string" ? queryAddress(controlUrl) : null;
				if (query && control) return { query, control };
			}
		} catch {
			// Not the web app's settings: the address is the query part's own.
		}
	}
	return { query: base, control: null };
}

export function foldClient(addresses: Addresses, token: () => string | null, http: Http): ApiClient {
	return createApiClient({
		queryUrl: addresses.query,
		// Without a control address nothing writes, so this is never called.
		controlUrl: addresses.control ?? addresses.query,
		token: async () => token(),
		refresh: async () => false,
		fetch: fetchOver(http),
	});
}
