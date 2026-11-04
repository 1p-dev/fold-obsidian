/** What the plugin says to a person, in plain words. */
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
