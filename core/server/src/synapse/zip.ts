/**
 * A store-only (uncompressed) .zip writer. Obsidian opens it as a space. The
 * CRC table is hand-written because `node:zlib.crc32` is not guaranteed in
 * the Workers runtime, and compression would need a dependency.
 */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { path: string; content: string | Uint8Array };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
/** General purpose bit 11: file names are UTF-8. */
const UTF8_NAMES = 0x0800;
const VERSION = 20;

function dosDateTime(date: Date) {
	const year = Math.max(1980, date.getUTCFullYear());
	return {
		time:
			(date.getUTCHours() << 11) |
			(date.getUTCMinutes() << 5) |
			(date.getUTCSeconds() >> 1),
		date:
			((year - 1980) << 9) |
			((date.getUTCMonth() + 1) << 5) |
			date.getUTCDate(),
	};
}

export function zipStore(
	entries: ZipEntry[],
	modified = new Date(),
): Uint8Array {
	const encoder = new TextEncoder();
	const stamp = dosDateTime(modified);
	const files = entries.map((entry) => {
		const data =
			typeof entry.content === "string"
				? encoder.encode(entry.content)
				: entry.content;
		return { name: encoder.encode(entry.path), data, crc: crc32(data) };
	});
	const localSize = files.reduce(
		(sum, file) => sum + 30 + file.name.length + file.data.length,
		0,
	);
	const centralSize = files.reduce(
		(sum, file) => sum + 46 + file.name.length,
		0,
	);
	const bytes = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(bytes.buffer);
	let offset = 0;
	const offsets: number[] = [];
	for (const file of files) {
		offsets.push(offset);
		view.setUint32(offset, LOCAL_HEADER, true);
		view.setUint16(offset + 4, VERSION, true);
		view.setUint16(offset + 6, UTF8_NAMES, true);
		view.setUint16(offset + 8, 0, true); // stored
		view.setUint16(offset + 10, stamp.time, true);
		view.setUint16(offset + 12, stamp.date, true);
		view.setUint32(offset + 14, file.crc, true);
		view.setUint32(offset + 18, file.data.length, true);
		view.setUint32(offset + 22, file.data.length, true);
		view.setUint16(offset + 26, file.name.length, true);
		view.setUint16(offset + 28, 0, true);
		bytes.set(file.name, offset + 30);
		bytes.set(file.data, offset + 30 + file.name.length);
		offset += 30 + file.name.length + file.data.length;
	}
	const centralStart = offset;
	files.forEach((file, index) => {
		view.setUint32(offset, CENTRAL_HEADER, true);
		view.setUint16(offset + 4, VERSION, true);
		view.setUint16(offset + 6, VERSION, true);
		view.setUint16(offset + 8, UTF8_NAMES, true);
		view.setUint16(offset + 10, 0, true);
		view.setUint16(offset + 12, stamp.time, true);
		view.setUint16(offset + 14, stamp.date, true);
		view.setUint32(offset + 16, file.crc, true);
		view.setUint32(offset + 20, file.data.length, true);
		view.setUint32(offset + 24, file.data.length, true);
		view.setUint16(offset + 28, file.name.length, true);
		view.setUint16(offset + 30, 0, true); // extra
		view.setUint16(offset + 32, 0, true); // comment
		view.setUint16(offset + 34, 0, true); // disk
		view.setUint16(offset + 36, 0, true); // internal attributes
		view.setUint32(offset + 38, 0, true); // external attributes
		view.setUint32(offset + 42, offsets[index], true);
		bytes.set(file.name, offset + 46);
		offset += 46 + file.name.length;
	});
	view.setUint32(offset, END_RECORD, true);
	view.setUint16(offset + 4, 0, true);
	view.setUint16(offset + 6, 0, true);
	view.setUint16(offset + 8, files.length, true);
	view.setUint16(offset + 10, files.length, true);
	view.setUint32(offset + 12, centralSize, true);
	view.setUint32(offset + 16, centralStart, true);
	view.setUint16(offset + 20, 0, true);
	return bytes;
}
