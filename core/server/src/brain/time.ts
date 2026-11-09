import type { InstantRange } from "./repository.js";

export function validTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

type WallClock = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, format);
	}
	return format;
}

function wallClock(ms: number, timeZone: string): WallClock {
	const parts: Partial<WallClock> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
		if (part.type === "literal") continue;
		parts[part.type as keyof WallClock] = Number(part.value);
	}
	return parts as WallClock;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD of the instant in the time zone. */
export function localDate(ms: number, timeZone: string): string {
	const { year, month, day } = wallClock(ms, timeZone);
	return `${year}-${pad(month)}-${pad(day)}`;
}

/** HH:mm of the instant in the time zone. */
export function localTime(ms: number, timeZone: string): string {
	const { hour, minute } = wallClock(ms, timeZone);
	return `${pad(hour)}:${pad(minute)}`;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function validDate(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const utc = new Date(Date.UTC(year, month - 1, day));
	return (
		utc.getUTCFullYear() === year &&
		utc.getUTCMonth() === month - 1 &&
		utc.getUTCDate() === day
	);
}

/** The instant at which the zone's clock reads midnight at the start of `date`. */
function startOfDay(date: string, timeZone: string): number {
	const [year, month, day] = date.split("-").map(Number);
	const wall = Date.UTC(year, month - 1, day);
	// Guess UTC midnight, measure the zone offset there, correct, and measure
	// again so a DST change on that night still lands on the right instant.
	let instant = wall;
	for (let pass = 0; pass < 2; pass++) {
		const clock = wallClock(instant, timeZone);
		const asUtc = Date.UTC(
			clock.year,
			clock.month - 1,
			clock.day,
			clock.hour,
			clock.minute,
			clock.second,
		);
		instant = wall - (asUtc - instant);
	}
	// Where clocks skip midnight (America/Santiago in September), the computed
	// instant is still the previous evening; the day starts at the jump.
	if (localDate(instant, timeZone) !== date) {
		let before = instant;
		let after = instant + 3 * 3_600_000;
		if (localDate(after, timeZone) !== date) return instant;
		while (after - before > 1) {
			const middle = Math.floor((before + after) / 2);
			if (localDate(middle, timeZone) === date) after = middle;
			else before = middle;
		}
		instant = after;
	}
	return instant;
}

/** The UTC instants spanned by `date` in the time zone. */
export function dayRange(date: string, timeZone: string): InstantRange {
	const from = startOfDay(date, timeZone);
	const next = new Date(from + 36 * 3_600_000);
	const to = startOfDay(localDate(next.getTime(), timeZone), timeZone);
	return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
