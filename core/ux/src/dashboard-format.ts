import type { UsageMetrics } from "@autonomo.us/common";

/** Number and money formats shared by the dashboard's tabs. */
export const plain = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 1,
});
const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 4,
});
export const count = (value: number) =>
	value >= 10_000 ? compact.format(value) : plain.format(value);
export const percent = (value: number, total: number) =>
	total ? `${plain.format((value / total) * 100)}%` : "—";
export const formatMoney = (value: number) =>
	value > 0 && value < 0.0001 ? "<$0.0001" : money.format(value);
export const cost = (row: UsageMetrics) =>
	row.pricedRequests ? formatMoney(row.estimatedCostUsd) : "—";
export const costLabel = (row: UsageMetrics) =>
	`${cost(row)}${row.pricedRequests && row.pricedRequests < row.requests ? " + unknown" : ""}`;
export const dateTime = (value: string) => new Date(value).toLocaleString();
export const shortDate = (value: string) =>
	new Date(value).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
/** "just now", "5 minutes ago", "yesterday", or a date past a week. */
export function ago(value: string, now = Date.now()): string {
	const seconds = Math.round((Date.parse(value) - now) / 1000);
	const size = Math.abs(seconds);
	if (size < 45) return "just now";
	if (size < 3600) return relative.format(Math.round(seconds / 60), "minute");
	if (size < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
	if (size < 7 * 86_400)
		return relative.format(Math.round(seconds / 86_400), "day");
	return shortDate(value);
}

export const plural = (n: number, one: string, many = `${one}s`) =>
	`${count(n)} ${n === 1 ? one : many}`;
