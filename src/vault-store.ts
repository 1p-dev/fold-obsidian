/** The sync's store over Obsidian's Vault API, which serialises writes and keeps Obsidian's index of the vault up to date. */
import { type App, normalizePath, TFile, TFolder } from "obsidian";
import type { Store } from "./sync";

export class VaultStore implements Store {
	constructor(private readonly app: App) {}

	private file(path: string): TFile | null {
		const found = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return found instanceof TFile ? found : null;
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	async read(path: string): Promise<Uint8Array | null> {
		const file = this.file(path);
		return file ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const target = normalizePath(path);
		const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const file = this.file(target);
		if (file) {
			await this.app.vault.modifyBinary(file, data);
			return;
		}
		await this.folderFor(target);
		await this.app.vault.createBinary(target, data);
	}

	async trash(path: string): Promise<void> {
		const file = this.file(path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	private async folderFor(path: string): Promise<void> {
		const segments = path.split("/").slice(0, -1);
		for (let depth = 1; depth <= segments.length; depth += 1) {
			const folder = segments.slice(0, depth).join("/");
			const found = this.app.vault.getAbstractFileByPath(folder);
			if (found === null) await this.app.vault.createFolder(folder);
			else if (!(found instanceof TFolder)) throw new Error("a file stands where a note's folder goes");
		}
	}
}
