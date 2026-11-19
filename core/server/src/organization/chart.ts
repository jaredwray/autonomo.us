import { randomUUID } from "node:crypto";
import type {
	DecisionRoute,
	DecisionRouteStep,
	DecisionRule,
	DecisionRuleInput,
	OrgActorRef,
	OrgBranch,
	OrgIdentity,
	OrgPosition,
	OrgPositionInput,
	OrgSettings,
	RoutePosition,
} from "@autonomo.us/common";
import { ServiceError } from "../service-error.js";
import type { OrganizationDirectory, OrgPrincipal } from "./directory.js";
import {
	type OrganizationRepository,
	type OrgGraph,
	sameActor,
} from "./repository.js";

export const conflict = () =>
	new ServiceError(
		"This decision or organization changed. Refresh and try again.",
		409,
	);
export const forbidden = () =>
	new ServiceError(
		"Your current workspace access does not permit this action.",
		403,
	);
export const missingPosition = () =>
	new ServiceError("Position not found in this workspace.", 404);
export function boundedText(
	value: unknown,
	name: string,
	max: number,
	empty = false,
): string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		value.length > max
	)
		throw new ServiceError(
			`${name} must be ${empty ? "0" : "1"}–${max} characters.`,
		);
	return value.trim();
}
export function decisionKey(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,79}$/.test(value))
		throw new ServiceError(
			"Choose a lowercase decision key of at most 80 letters, digits, dots, hyphens or underscores.",
		);
	return value;
}
export function pageLimit(value?: unknown) {
	const limit = value === undefined ? 25 : Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new ServiceError("Choose a page size from 1 to 100.");
	return limit;
}
const byId = (g: OrgGraph, id: string | null | undefined) =>
	g.positions.find((p) => p.id === id);
const brief = (p: OrgPosition): RoutePosition => ({
	id: p.id,
	title: p.title,
	occupant: p.occupant,
});
export type OrgCaller = { workspaceId: string; actor: OrgActorRef };
export type BranchQuery = {
	positionId?: string;
	parentId?: string;
	q?: string;
	after?: string;
	limit?: number;
};
export type PreviewInput = {
	decisionKey: string;
	requesterPositionId?: string;
	rule?: DecisionRuleInput;
};
export class OrganizationChart {
	constructor(
		protected readonly repo: OrganizationRepository,
		protected readonly directory: OrganizationDirectory,
	) {}
	protected async principal(c: OrgCaller, manage = false) {
		if (!(await this.directory.active(c.workspaceId)))
			throw new ServiceError("This workspace is unavailable.", 409);
		const who = await this.directory.resolve(c.workspaceId, c.actor);
		if (!who?.use || (manage && !who.manage)) throw forbidden();
		return who;
	}
	async identities(c: OrgCaller, q = "") {
		await this.principal(c, true);
		const needle = boundedText(q, "Search", 140, true).toLowerCase();
		return {
			identities: (await this.directory.list(c.workspaceId))
				.filter((x) => x.name.toLowerCase().includes(needle))
				.slice(0, 100),
		};
	}
	async branch(c: OrgCaller, input: BranchQuery = {}): Promise<OrgBranch> {
		const who = await this.principal(c);
		const w = c.workspaceId,
			limit = pageLimit(input.limit);
		const own = await this.repo.occupied(w, c.actor);
		const result: OrgBranch = {
			leadPositionId: own.leadPositionId,
			humanFallbackPositionId: own.humanFallbackPositionId,
			canManage: who.manage,
			viewerPositionIds: own.positionIds,
			positions: [],
			next: null,
		};
		const q = boundedText(input.q ?? "", "Search", 140, true).toLowerCase();
		const focus = input.positionId ?? own.positionIds[0] ?? own.leadPositionId;
		let parentId = input.parentId ?? null;
		if (!q && input.parentId === undefined && focus) {
			const selected = (await this.repo.select(w, { ids: [focus] }))
				.positions[0];
			if (!selected) throw missingPosition();
			parentId = selected.id;
			if (!input.after) {
				const manager = selected.managerId
					? (
							await this.repo.select(w, {
								ids: [selected.managerId],
								active: true,
							})
						).positions[0]
					: null;
				// The requested position always fits, even on a one-position page.
				if (manager && limit > 1) result.positions.push(manager);
				result.positions.push(selected);
			}
		}
		const available = limit - result.positions.length;
		const found = await this.repo.select(w, {
			...(q ? { q } : { parentId }),
			active: true,
			after: input.after,
			limit: available + 1,
		});
		result.positions.push(...found.positions.slice(0, available));
		if (found.positions.length > available)
			result.next = available ? found.positions[available - 1].id : "!";
		return result;
	}
	private async edit<T>(
		c: OrgCaller,
		apply: (graph: OrgGraph) => Promise<T> | T,
	): Promise<T> {
		for (let attempt = 0; attempt < 12; attempt++) {
			await this.principal(c, true);
			const graph = await this.repo.graph(c.workspaceId);
			const result = await apply(graph),
				revision = graph.revision++;
			// Leave capacity for the short-lived prepared case used for a fenced transition.
			if (Buffer.byteLength(JSON.stringify(graph)) > 12 * 1024 * 1024)
				throw new ServiceError(
					"This organization has reached its storage limit.",
					409,
				);
			if (await this.repo.saveGraph(c.workspaceId, graph, revision))
				return result;
		}
		throw conflict();
	}
	async position(
		c: OrgCaller,
		id: string | null,
		input: OrgPositionInput,
	): Promise<OrgPosition> {
		const newId = id ?? randomUUID();
		return this.edit(c, async (graph) => {
			const pos = id
				? byId(graph, id)
				: {
						id: newId,
						title: "",
						remit: "",
						authority: "",
						managerId: null,
						occupant: null,
						archived: false,
						childCount: 0,
					};
			if (!pos) throw missingPosition();
			if (!id || input.title !== undefined)
				pos.title = boundedText(input.title, "Title", 160);
			if (input.remit !== undefined)
				pos.remit = boundedText(input.remit, "Remit", 2000, true);
			if (input.authority !== undefined)
				pos.authority = boundedText(input.authority, "Authority", 2000, true);
			if (input.occupant !== undefined) {
				const ref = input.occupant;
				if (
					ref !== null &&
					(!["user", "agent"].includes(ref?.kind) ||
						typeof ref?.id !== "string")
				)
					throw new ServiceError("Choose a workspace member or agent.");
				const principal = ref
					? await this.directory.resolve(c.workspaceId, ref)
					: null;
				if (ref && !principal)
					throw new ServiceError(
						"Choose an active workspace member or agent.",
						409,
					);
				if (
					graph.humanFallbackPositionId === id &&
					principal &&
					principal.identity.kind !== "user" &&
					id
				)
					throw new ServiceError(
						"The accountable fallback must be a person.",
						409,
					);
				pos.occupant = principal?.identity ?? null;
			}
			if (input.managerId !== undefined) {
				const manager =
					input.managerId === null ? null : byId(graph, input.managerId);
				if (input.managerId !== null && (!manager || manager.archived))
					throw missingPosition();
				for (
					let ancestor = manager;
					ancestor;
					ancestor = byId(graph, ancestor.managerId) ?? null
				)
					if (ancestor.id === pos.id)
						throw new ServiceError(
							"This reporting line would create a cycle.",
							409,
						);
				pos.managerId = input.managerId;
			}
			if (input.archived !== undefined) {
				if (typeof input.archived !== "boolean")
					throw new ServiceError("Archived must be true or false.");
				pos.archived = input.archived;
				if (pos.archived) {
					for (const report of graph.positions)
						if (report.managerId === pos.id) report.managerId = pos.managerId;
					pos.managerId = null;
					if (graph.leadPositionId === pos.id) graph.leadPositionId = null;
					if (graph.humanFallbackPositionId === pos.id)
						graph.humanFallbackPositionId = null;
				}
			}
			if (!id) {
				graph.positions.push(pos);
				graph.positions.sort((a, b) => a.id.localeCompare(b.id));
			}
			const counts = new Map<string, number>();
			for (const p of graph.positions)
				if (p.managerId && !p.archived)
					counts.set(p.managerId, (counts.get(p.managerId) ?? 0) + 1);
			for (const p of graph.positions) p.childCount = counts.get(p.id) ?? 0;
			return pos;
		});
	}
	async settings(c: OrgCaller, input: OrgSettings): Promise<OrgSettings> {
		return this.edit(c, async (g) => {
			for (const id of [input.leadPositionId, input.humanFallbackPositionId])
				if (
					id !== null &&
					(typeof id !== "string" || !byId(g, id) || byId(g, id)?.archived)
				)
					throw missingPosition();
			if (input.humanFallbackPositionId) {
				const occupant = byId(g, input.humanFallbackPositionId)?.occupant;
				if (
					occupant?.kind !== "user" ||
					!(await this.directory.resolve(c.workspaceId, occupant))?.decide
				)
					throw new ServiceError(
						"Choose a position held by an active workspace member as the human fallback.",
					);
			}
			g.leadPositionId = input.leadPositionId;
			g.humanFallbackPositionId = input.humanFallbackPositionId;
			return {
				leadPositionId: g.leadPositionId,
				humanFallbackPositionId: g.humanFallbackPositionId,
			};
		});
	}
	async rules(c: OrgCaller) {
		await this.principal(c);
		return {
			rules: (await this.repo.select(c.workspaceId, { limit: 0 }, "*")).rules,
		};
	}
	private validateRule(input: DecisionRuleInput) {
		if (
			typeof input?.ownerPositionId !== "string" ||
			!Array.isArray(input.fallbackPositionIds) ||
			input.fallbackPositionIds.length > 12 ||
			!input.fallbackPositionIds.every((id) => typeof id === "string")
		)
			throw new ServiceError(
				"Choose an owner and up to 12 ordered fallback positions.",
			);
		if (
			new Set([input.ownerPositionId, ...input.fallbackPositionIds]).size !==
			input.fallbackPositionIds.length + 1
		)
			throw new ServiceError(
				"Each position must occur only once in the route.",
			);
		if (
			!Number.isInteger(input.deadlineMinutes) ||
			input.deadlineMinutes < 1 ||
			input.deadlineMinutes > 43200
		)
			throw new ServiceError("The response deadline must be 1–43200 minutes.");
	}
	async rule(
		c: OrgCaller,
		key: string,
		input: DecisionRuleInput & { expectedVersion?: number },
	): Promise<DecisionRule> {
		return this.edit(c, (g) => {
			decisionKey(key);
			this.validateRule(input);
			for (const id of [input.ownerPositionId, ...input.fallbackPositionIds])
				if (!byId(g, id) || byId(g, id)?.archived) throw missingPosition();
			const previous = g.rules.find((r) => r.key === key);
			if (
				input.expectedVersion !== undefined &&
				input.expectedVersion !== (previous?.version ?? 0)
			)
				throw conflict();
			const rule = {
				key,
				version: (previous?.version ?? 0) + 1,
				ownerPositionId: input.ownerPositionId,
				fallbackPositionIds: [...input.fallbackPositionIds],
				deadlineMinutes: input.deadlineMinutes,
			};
			g.rules = g.rules
				.filter((r) => r.key !== key)
				.concat(rule)
				.sort((a, b) => a.key.localeCompare(b.key));
			return rule;
		});
	}
	protected async eligible(
		w: string,
		p: OrgPosition | undefined,
		humanOnly = false,
	): Promise<OrgIdentity | null> {
		if (!p?.occupant || p.archived || (humanOnly && p.occupant.kind !== "user"))
			return null;
		const who = await this.directory.resolve(w, p.occupant);
		return who?.use && who.decide ? who.identity : null;
	}
	protected async routing(
		c: OrgCaller,
		who: OrgPrincipal,
		input: PreviewInput,
		preview = false,
	): Promise<{ route: DecisionRoute; graphRevision: number }> {
		const key = decisionKey(input.decisionKey),
			w = c.workspaceId;
		if (input.rule && !(preview && who.manage)) throw forbidden();
		const own = await this.repo.select(
			w,
			input.requesterPositionId
				? { ids: [input.requesterPositionId], active: true }
				: { occupant: c.actor, active: true, limit: 2 },
			key,
		);
		const requester = own.positions[0] ?? null;
		if (input.requesterPositionId && !requester) throw missingPosition();
		if (
			requester &&
			!sameActor(requester.occupant, c.actor) &&
			!(preview && who.manage)
		)
			throw forbidden();
		if (!input.requesterPositionId && own.positions.length > 1)
			throw new ServiceError(
				"You hold multiple positions. Specify requesterPositionId.",
				409,
			);
		const saved = own.rules[0];
		if (input.rule) this.validateRule(input.rule);
		const rule = input.rule ?? saved;
		const candidates: Array<{
			id: string;
			role: DecisionRouteStep["role"];
			reason: string;
		}> = [];
		const add = (
			id: string | null | undefined,
			role: DecisionRouteStep["role"],
			reason: string,
		) => {
			if (id && !candidates.some((step) => step.id === id))
				candidates.push({ id, role, reason });
		};
		if (rule) {
			add(
				rule.ownerPositionId,
				"owner",
				`The ${key} rule names this position as decision owner.`,
			);
			for (const id of rule.fallbackPositionIds)
				add(id, "fallback", `Ordered fallback in the ${key} rule.`);
		} else
			add(
				requester?.managerId,
				"owner",
				"No matching decision rule. Route to the requester's primary manager.",
			);
		add(
			own.humanFallbackPositionId,
			"fallback",
			"Accountable human fallback for this workspace.",
		);
		const positions = await this.repo.select(w, {
			ids: candidates.map((x) => x.id),
		});
		if (positions.revision !== own.revision) throw conflict();
		const steps = await Promise.all(
			candidates.map(async (item) => {
				const pos = byId(positions, item.id);
				if (!pos || (input.rule && pos.archived)) throw missingPosition();
				return {
					position: brief(pos),
					role: item.role,
					reason: item.reason,
					...(pos.id === own.humanFallbackPositionId
						? { humanOnly: true }
						: {}),
					eligible: !!(await this.eligible(
						w,
						pos,
						pos.id === own.humanFallbackPositionId,
					)),
				};
			}),
		);
		return {
			graphRevision: positions.revision,
			route: {
				decisionKey: key,
				ruleVersion: input.rule
					? (saved?.version ?? 0) + 1
					: (saved?.version ?? null),
				requesterPosition: requester ? brief(requester) : null,
				steps,
				deadlineMinutes: rule?.deadlineMinutes ?? 30,
			},
		};
	}
	async preview(c: OrgCaller, input: PreviewInput) {
		return (await this.routing(c, await this.principal(c), input, true)).route;
	}
}
