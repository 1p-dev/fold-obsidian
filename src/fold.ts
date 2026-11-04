/**
 * Fold's API through the web app's own client, so there is one owner of its routes and refusals. Only the way out differs: Obsidian's `requestUrl`, which is not held to a browser's cross-origin rules and works on phones. The plugin only ever makes the client's read calls.
 */
import { type ApiClient, createApiClient } from "./api/client";

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
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

/** `fetch` over Obsidian's `requestUrl`. The body stays bytes, so a file's bytes arrive as they were sent. */
export function fetchOver(http: Http): typeof fetch {
	return async (input, init) => {
		const answer = await withinTimeout(
			http({
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				method: init?.method ?? "GET",
				headers: (init?.headers ?? {}) as Record<string, string>,
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

export function foldClient(queryUrl: string, token: () => string | null, http: Http): ApiClient {
	return createApiClient({
		queryUrl,
		// Nothing here writes, and this is never called: the client asks for both addresses.
		controlUrl: queryUrl,
		token: async () => token(),
		refresh: async () => false,
		fetch: fetchOver(http),
	});
}
