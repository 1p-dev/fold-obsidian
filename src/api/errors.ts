import { ApiError } from "./client";

/**
 * A refusal in plain words, at the level its reason lives (dev-skills/ui-design, "Unavailable things"). 1p not answering is a retryable "couldn't check", never "no access".
 */
export function describeError(error: unknown): string {
	if (!(error instanceof ApiError)) return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
	switch (error.code) {
		case "unreachable":
			return "Fold could not be reached. Check your connection and try again.";
		case "unauthorised":
			return "Your sign-in has ended. Sign in again to carry on.";
		case "not-found":
			return "This space doesn't exist, or you don't have access to it.";
		case "file-not-found":
			return "This file isn't among the space's indexed files.";
		case "forbidden":
		case "not-permitted":
			return "Your access to this space, or your sign-in's scope, doesn't allow this.";
		case "indexing":
			return "Fold is still indexing this space. Try again when it says Ready.";
		case "reindexing":
			return "This space is already being re-indexed. It says Indexing until that is done.";
		case "changed":
			return "This file changed after you opened it.";
		case "access-unavailable":
			return "Couldn't check your access: 1p did not answer. Try again in a moment.";
		case "identity-unavailable":
			return "Couldn't check your sign-in: 1p did not answer. Try again in a moment.";
		case "embedding-unavailable":
			return "Search is unavailable for a moment: the embedding model did not answer. Try again shortly.";
		case "unsupported-type":
			return "Fold doesn't take this kind of file here. Spaces hold text, such as Markdown, and PDF, Word and PowerPoint files, which go in reference/ and which Fold converts.";
		case "too-large":
			return "This is too large for Fold to take: a file's text is at most 1 MiB, and a PDF, Word or PowerPoint file at most 80 MB.";
		case "name-taken":
			return "Another note in this space already has that name, in another folder or case. Choose a different name.";
		case "no-previous-version":
			return "This file has no earlier version to put back.";
		case "holds-credential":
			// The API's sentence ends in what a caller sends to override it; here that is a button.
			return `${error.detail.charAt(0).toUpperCase()}${error.detail.split(":")[0]?.slice(1) ?? ""}. Take it out and save again, or save anyway if it is meant to be there.`;
		case "rate-limited":
			return "This space has as many files converting as it takes at once. Try again once some have finished.";
		case "memory-off":
			return "This space's memory is off, so it keeps no notes. An admin can turn it on in Settings.";
		case "line-too-long":
			return `${error.detail.charAt(0).toUpperCase()}${error.detail.slice(1).replace(/\.$/, "")}.`;
		case "bad-request":
			return `Fold refused this: ${error.detail.replace(/\.$/, "")}.`;
		default:
			return "Something went wrong in Fold. Try again.";
	}
}

export function errorCode(error: unknown): string | null {
	return error instanceof ApiError ? error.code : null;
}
