import {
	OVERVIEW_BUDGET_WARNING,
	type WorkspaceOverview,
} from "@autonomo.us/common";
import { formatMoney, plain, plural, shortDate } from "./dashboard-format.js";

/** Something on a workspace's overview that a person should look at. */
export type AttentionItem = {
	id: string;
	text: string;
	detail?: string;
	/** Where it is dealt with. */
	href: string;
	/** True when the signed-in person can act on it, not only see it. */
	yours: boolean;
	severity: "info" | "warning" | "critical";
};

const workspaceHref = (workspaceId: string, path: string) =>
	`#/w/${encodeURIComponent(workspaceId)}/${path}`;

/**
 * What is waiting in a workspace, most severe first. Items the person may
 * act on are `yours`; the rest wait on a workspace admin.
 */
export function attentionItems(
	overview: WorkspaceOverview,
	workspaceId: string,
): AttentionItem[] {
	const { waiting, can, budget } = overview;
	const href = (path: string) => workspaceHref(workspaceId, path);
	const items: AttentionItem[] = [];
	for (const problem of waiting.proxyProblems)
		items.push({
			id: `proxy:${problem.name}`,
			text: `Proxy ${problem.name} needs attention`,
			detail: problem.detail,
			href: href("proxies"),
			yours: can.editProxies,
			severity: "critical",
		});
	if (budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd)
		items.push({
			id: "budget",
			text: "The proxy budget for this month is used up",
			detail: `${formatMoney(budget.spentUsd)} of ${formatMoney(budget.limitUsd)}. Fetches that need a proxy are refused until it is raised or the month ends.`,
			href: href("proxies"),
			yours: can.editProxies,
			severity: "critical",
		});
	else if (
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
			href: "#/team",
			yours: true,
			severity: "info",
		});
	const rank = { critical: 0, warning: 1, info: 2 };
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				rank[a.item.severity] - rank[b.item.severity] || a.index - b.index,
		)
		.map(({ item }) => item);
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
