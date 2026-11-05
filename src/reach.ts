/** Whether the plugin can reach Fold with what a person has set, so the settings can say so: a wrong address, a missing secret, a refused token and a token that reaches no space each look the same otherwise, an empty list. */
import { errorCode } from "./api/errors";
import { type Addresses, foldClient, type Http, queryAddress } from "./fold";
import type { Connection } from "./saved";
import { describeRefusal } from "./words";

export interface SpaceChoice {
	id: string;
	title: string;
}

export type Reach =
	| { kind: "no-address" }
	| { kind: "bad-address" }
	| { kind: "no-token" }
	| { kind: "no-secret"; name: string }
	| { kind: "connecting" }
	/** An address typed since the settings opened whose `/config.json` names Fold's parts. The token waits for the person's Connect. */
	| { kind: "web-app-found" }
	/** An address typed since the settings opened whose `/config.json` does not name Fold's parts. */
	| { kind: "not-web-app" }
	/** `readsOnly` when the address names only Fold's query part, so edits cannot be sent. */
	| { kind: "connected"; spaces: SpaceChoice[]; readsOnly: boolean }
	/** An answer that is not Fold's, said in fixed words, since any host can answer anything. */
	| { kind: "not-fold" }
	| { kind: "failed"; words: string };

type Setup = Pick<Connection, "queryUrl" | "secretName">;

/** Refusals whose sentences are fixed and say something true of this call. Any other answer may carry a host's own words. */
const SAID_AS_IS = new Set(["unreachable", "unauthorised", "forbidden", "not-permitted", "access-unavailable", "identity-unavailable"]);

function why(error: unknown): Reach {
	return SAID_AS_IS.has(errorCode(error) ?? "") ? { kind: "failed", words: describeRefusal(error) } : { kind: "not-fold" };
}

/** What is still missing before Fold can be asked, or null when nothing is. Nothing is sent until then. */
export function missingSetup({ queryUrl, secretName }: Setup, secret: (name: string) => string | null): Reach | null {
	if (!queryUrl.trim()) return { kind: "no-address" };
	if (!queryAddress(queryUrl)) return { kind: "bad-address" };
	if (!secretName) return { kind: "no-token" };
	// A secret's name can outlive the secret, as when it is deleted in Obsidian's own settings.
	if (!secret(secretName)) return { kind: "no-secret", name: secretName };
	return null;
}

/**
 * An address typed since the settings opened may be half of one, such as `fold.1p.de` on the way to `fold.1p.dev`, and anyone can serve a `/config.json` there. So it is only asked, without the token, whether it names Fold's parts, and the token waits for the person to select Connect. Null when the question was abandoned.
 */
export async function probeFold(asked: Setup, addresses: (text: string) => Promise<Addresses | null>, stillWanted: () => boolean): Promise<Reach | null> {
	try {
		const found = await addresses(asked.queryUrl);
		if (!stillWanted()) return null;
		if (!found) return { kind: "bad-address" };
		return found.control === null ? { kind: "not-web-app" } : { kind: "web-app-found" };
	} catch (error) {
		return stillWanted() ? why(error) : null;
	}
}

/**
 * Asks Fold for the spaces the person's token reaches, which is the one call that proves the address and the token together: for the address saved when the settings opened, as a round would ask it, or one the person chose to connect. The address and the secret's name are taken once, when asked, so a later change never sends a newer token to an older address, and nothing is sent once `stillWanted` says the question was abandoned. Null when it was.
 */
export async function reachFold(asked: Setup, secret: (name: string) => string | null, addresses: (text: string) => Promise<Addresses | null>, http: Http, stillWanted: () => boolean): Promise<Reach | null> {
	const setup = { queryUrl: asked.queryUrl, secretName: asked.secretName };
	const missing = missingSetup(setup, secret);
	if (missing) return missing;
	const token = secret(setup.secretName); // secret-scan-ok: read from Obsidian's secret storage once, when asked; no value is written here
	try {
		const found = await addresses(setup.queryUrl);
		if (!stillWanted()) return null;
		if (!found) return { kind: "bad-address" };
		const list: unknown = await foldClient(found, () => token, http).listSpaces();
		if (!stillWanted()) return null;
		const spaces = typeof list === "object" && list !== null && Array.isArray((list as { spaces?: unknown }).spaces) ? (list as { spaces: unknown[] }).spaces : null;
		if (!spaces) return { kind: "not-fold" };
		const choices = spaces.filter((space): space is SpaceChoice => typeof (space as SpaceChoice)?.id === "string" && typeof (space as SpaceChoice).title === "string");
		return { kind: "connected", spaces: choices.map(({ id, title }) => ({ id, title })), readsOnly: found.control === null };
	} catch (error) {
		return stillWanted() ? why(error) : null;
	}
}
