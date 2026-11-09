import type { BrainFile } from "@autonomo.us/common";

/**
 * Vault-relative path for a picked file. A folder picker (webkitdirectory)
 * reports paths starting with the chosen folder's name, which is not part of
 * the vault, so it is dropped; single files keep their names.
 */
export function vaultRelativePath(file: File): string {
	const relative = (file as File & { webkitRelativePath?: string })
		.webkitRelativePath;
	if (!relative) return file.name;
	const parts = relative.split("/").filter(Boolean);
	return (parts.length > 1 ? parts.slice(1) : parts).join("/");
}

export function readFileText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () =>
			reject(reader.error ?? new Error(`Could not read ${file.name}`));
		reader.readAsText(file);
	});
}

/** Reads picked files into import entries, keeping only Markdown. */
export async function filesToBrainFiles(
	files: Iterable<File>,
): Promise<BrainFile[]> {
	const entries: BrainFile[] = [];
	for (const file of files) {
		const path = vaultRelativePath(file);
		if (!path.toLowerCase().endsWith(".md")) continue;
		entries.push({ path, content: await readFileText(file) });
	}
	return entries;
}

/** Saves a blob through a temporary object URL. */
export function downloadBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The server takes at most 500 files and 5 MB per import request. */
export const IMPORT_BATCH_FILES = 500;
export const IMPORT_BATCH_BYTES = 4_000_000;

/**
 * Splits import entries into requests the server accepts, so a vault larger
 * than one request's limits still imports. A file too big for any batch goes
 * alone and the server reports it.
 */
export function importBatches(
	files: BrainFile[],
	maxFiles = IMPORT_BATCH_FILES,
	maxBytes = IMPORT_BATCH_BYTES,
): BrainFile[][] {
	const encoder = new TextEncoder();
	const batches: BrainFile[][] = [];
	let current: BrainFile[] = [];
	let bytes = 0;
	for (const file of files) {
		const size = encoder.encode(JSON.stringify(file)).length + 1;
		if (
			current.length &&
			(current.length >= maxFiles || bytes + size > maxBytes)
		) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(file);
		bytes += size;
	}
	if (current.length) batches.push(current);
	return batches;
}
