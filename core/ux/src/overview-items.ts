import {
	OVERVIEW_BUDGET_WARNING,
	type UsageAnalytics,
	type WorkspaceOverview,
} from "@autonomo.us/common";
import {
	formatMoney,
	percent,
	plain,
	plural,
	shortDate,
} from "./dashboard-format.js";

/** Something on a workspace's overview that a person should look at. */
export type AttentionItem = {
	id: string;
	text: string;
	detail?: string;
	/** Where it is dealt with. */
	href: string;
	/** True when the signed-in person can act on it, not only see it. */
	yours: boolean;
	/** True for the whole team (invites), the same in every workspace. */
	org?: boolean;
	severity: "info" | "warning" | "critical";
};

/** A connection is failing once this many calls in the period failed, at this share. */
const FAILING_CALLS = 5;
const FAILING_SHARE = 0.5;

const workspaceHref = (workspaceId: string, path: string) =>
	`#/w/${encodeURIComponent(workspaceId)}/${path}`;

const rank = { critical: 0, warning: 1, info: 2 };
const bySeverity = (items: AttentionItem[]) =>
	items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				rank[a.item.severity] - rank[b.item.severity] || a.index - b.index,
		)
		.map(({ item }) => item);

/**
 * What is waiting in a workspace, most severe first. Items the person may
 * act on are `yours`; the rest wait on a workspace admin. With the period's
 * analytics, model connections that keep failing are listed too.
 */
export function attentionItems(
	overview: WorkspaceOverview,
	workspaceId: string,
	analytics?: UsageAnalytics | null,
): AttentionItem[] {
	const { waiting, can, budget } = overview;
	const href = (path: string) => workspaceHref(workspaceId, path);
	const items: AttentionItem[] = [];
	for (const row of analytics?.byProvider ?? [])
		if (
			row.errors >= FAILING_CALLS &&
			row.errors >= row.requests * FAILING_SHARE
		)
			items.push({
				id: `connection:${row.id}`,
				text: `Connection ${row.name} failed ${percent(row.errors, row.requests)} of its calls`,
				detail: `${plural(row.errors, "failed call")} of ${plain.format(row.requests)} in this period. Check its key and models.`,
				href: href("models"),
				yours: can.manageAgents,
				severity: "critical",
			});
	for (const bot of waiting.failingBots)
		items.push({
			id: `failing:${bot.id}`,
			text: `${bot.name} failed ${bot.failed} of its last ${plural(bot.replies, "reply", "replies")}`,
			detail: "Its model call keeps failing. The error is on its replies.",
			href: href(`agents/${bot.id}`),
			yours: can.manageAgents,
			severity: "critical",
		});
	for (const problem of waiting.proxyProblems)
		items.push({
			id: `proxy:${problem.name}`,
			text: `Proxy ${problem.name} needs attention`,
			detail: problem.detail,
			href: href("proxies"),
			yours: can.editProxies,
			severity: "critical",
		});
	if (budget && budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd)
		items.push({
			id: "budget",
			text: "The proxy budget for this month is used up",
			detail: `${formatMoney(budget.spentUsd)} of ${formatMoney(budget.limitUsd)}. Fetches that need a proxy are refused until it is raised or the month ends.`,
			href: href("proxies"),
			yours: can.editProxies,
			severity: "critical",
		});
	else if (
		budget &&
		budget.limitUsd > 0 &&
		budget.spentUsd >= budget.limitUsd * OVERVIEW_BUDGET_WARNING
	)
		items.push({
			id: "budget",
			text: `${plain.format(Math.floor((budget.spentUsd / budget.limitUsd) * 100))}% of the proxy budget is spent`,
			detail: `${formatMoney(budget.spentUsd)} of ${formatMoney(budget.limitUsd)} this month.`,
			href: href("proxies"),
			yours: can.editProxies,
			severity: "warning",
		});
	for (const mention of waiting.mentions)
		items.push({
			id: `mention:${mention.channelId}`,
			text: `${plural(mention.count, "unread mention")} in #${mention.name}`,
			href: href(`channels/${encodeURIComponent(mention.name)}`),
			yours: true,
			severity: "info",
		});
	if (waiting.proposals > 0)
		items.push({
			id: "proposals",
			text: `${plural(waiting.proposals, "Synapse proposal")} to review`,
			detail: "Agents asked to change the shared space.",
			href: href("synapse/proposals"),
			yours: can.decideProposals,
			severity: "info",
		});
	for (const request of waiting.siteRequests)
		items.push({
			id: `sites:${request.botId}`,
			text: `${request.name} asked to fetch ${plural(request.count, "new site")}`,
			detail: "Approve a site to add it to the agent's list.",
			href: href(`agents/${request.botId}`),
			yours: can.manageAgents,
			severity: "info",
		});
	for (const bot of waiting.botsAtLimit)
		items.push({
			id: `limit:${bot.id}`,
			text: `${bot.name} reached its ${bot.limit === "tokens" ? "daily token" : "hourly reply"} limit`,
			detail:
				bot.limit === "tokens"
					? "It answers again after midnight UTC, or when the limit is raised."
					: "It answers again within the hour, or when the limit is raised.",
			href: href(`agents/${bot.id}`),
			yours: can.manageAgents,
			severity: "warning",
		});
	for (const agent of waiting.expiringAgents)
		items.push({
			id: `expiring:${agent.id}`,
			text: `${agent.name}'s token expires ${shortDate(agent.expiresAt)}`,
			detail: "Roll it before then, or the agent stops working.",
			href: href(`agents/${agent.id}`),
			yours: can.manageAgents,
			severity: "warning",
		});
	for (const token of waiting.expiringApiTokens ?? [])
		items.push({
			id: `api-token:${token.id}`,
			text: `API token ${token.name} expires ${shortDate(token.expiresAt)}`,
			href: href("api-tokens"),
			yours: true,
			severity: "warning",
		});
	if (waiting.invites)
		items.push({
			id: "invites",
			text: `${plural(waiting.invites, "invite link")} not used yet`,
			detail: "For the whole team.",
			href: "#/team",
			yours: true,
			org: true,
			severity: "info",
		});
	return bySeverity(items);
}

/** Counts for the sidebar: what the person can act on in Synapse and Agents. */
export function overviewBadges(overview: WorkspaceOverview | null) {
	if (!overview) return { synapse: 0, agents: 0 };
	return {
		synapse: overview.can.decideProposals ? overview.waiting.proposals : 0,
		agents: overview.can.manageAgents
			? overview.waiting.siteRequests.reduce(
					(total, item) => total + item.count,
					0,
				)
			: 0,
	};
}

/** The newer of two overviews of the same workspace, or whichever exists. */
export function newerOverview(
	a: WorkspaceOverview | null | undefined,
	b: WorkspaceOverview | null | undefined,
): WorkspaceOverview | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return b.generatedAt > a.generatedAt ? b : a;
}
