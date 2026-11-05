/** What the plugin says to a person, in plain words. */
import { ApiError } from "./api/client";
import { describeError, errorCode } from "./api/errors";
import type { SyncReport } from "./sync";

export function describeRefusal(error: unknown): string {
	switch (errorCode(error)) {
		case "unauthorised":
			return "Fold refused the token. Check it in this plugin's settings.";
		case "not-found":
			return "Fold has no such space, or your token can't reach it. The notes already here stay as they are.";
		case "other-space":
			return "This vault holds the notes of another space. Disconnect in this plugin's settings before choosing a new one, or use another vault.";
		default:
			return describeError(error);
	}
}

/** Why Fold would not take what was sent, in the plugin's own terms, since a person cannot answer the web app's questions here. */
export function describeNotSent(error: unknown): string {
	switch (errorCode(error)) {
		case "not-permitted":
		case "forbidden":
			// Fold's own reason says which: the token's scope, the person's access, or a folder only sleep writes.
			return error instanceof ApiError && error.detail ? `Fold refused it: ${error.detail.replace(/\.$/, "")}` : "sending needs a token with the fold:write scope, and edit access to this space, or contribute access for a new note";
		case "holds-credential":
			return "Fold thinks it holds a credential, such as a key or a password. Take it out, and it is sent when you next change it";
		case "name-taken":
			return "another note in the space has that name. Rename yours to send it";
		case "not-text":
			return "it is not UTF-8 text";
		case "memory-off":
			return "this space takes no notes";
		default:
			return describeError(error).replace(/\.$/, "");
	}
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The status bar after a round. A space whose notes are all still being indexed holds none yet, which is not the same as having none. */
export function describeHeld(held: number, report: SyncReport): string {
	const waiting = report.waiting > 0 ? `, ${report.waiting} being indexed` : "";
	const failing = report.failed.length > 0 ? `, ${report.failed.length} failed` : "";
	if (held === 0 && report.ran && report.waiting === 0) return `Fold: no notes${failing}`;
	return `Fold: ${count(held, "note")}${waiting}${failing}`;
}

/** Paths by name, the first few and how many more. */
function named(paths: readonly string[]): string {
	const shown = paths.slice(0, 3).join(", ");
	return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** What a timer's round has already told a person, so it is not said again every few minutes. */
export function saidBy(report: SyncReport): Set<string> {
	return new Set([...report.blocked, ...report.failed, ...(report.heldRemovals > 0 ? ["held removals"] : [])]);
}

/**
 * A round's result, or null when nothing happened worth saying. A round a person asked for says everything. A timer's says only what they may need to act on, and each such thing once, since an agent's busy space moves every few minutes.
 */
export function describeRound(report: SyncReport, asked: boolean, alreadySaid: ReadonlySet<string>): string | null {
	const fresh = (paths: readonly string[]) => (asked ? paths : paths.filter((path) => !alreadySaid.has(path)));
	const parts: string[] = [];
	if (asked && report.written > 0) parts.push(`${count(report.written, "note")} updated`);
	if (asked && report.trashed > 0) parts.push(`${count(report.trashed, "note")} moved to the trash`);
	if (asked && report.waiting > 0) parts.push(`${count(report.waiting, "note")} still being indexed`);
	if (report.sent.length > 0) parts.push(`your edits to ${named(report.sent)} sent`);
	if (report.added.length > 0) parts.push(`${named(report.added)} saved to the space's inbox`);
	// Grouped by why, so each reason is said once with the notes it held back.
	const notSent = new Map<string, string[]>();
	for (const { path, error } of report.notSent) notSent.set(describeNotSent(error), [...(notSent.get(describeNotSent(error)) ?? []), path]);
	for (const [why, paths] of notSent) parts.push(`${named(paths)} not sent: ${why}`);
	if (report.editCopies.length > 0) parts.push(`your edits kept in ${named(report.editCopies)}`);
	if (report.keptEdited.length > 0) parts.push(`${named(report.keptEdited)} kept though Fold removed it, since you edited it`);
	if (fresh(report.blocked).length > 0) parts.push(`${named(fresh(report.blocked))} could not come here`);
	if (fresh(report.failed).length > 0) {
		parts.push(`${named(fresh(report.failed))} failed and will be tried again`);
		if (report.removalsWaiting > 0) parts.push(`${count(report.removalsWaiting, "note")} Fold removed stay here until then, or until you run "Sync notes now"`);
	}
	if (report.heldRemovals > 0 && (asked || !alreadySaid.has("held removals"))) parts.push(`Fold removed ${count(report.heldRemovals, "note")}, most of this vault. Run "Sync notes now" to take them out here too`);
	return parts.length > 0 ? `Fold: ${parts.join("; ")}.` : null;
}
