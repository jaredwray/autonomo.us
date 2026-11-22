import { randomUUID } from "node:crypto";
import {
	type CreateSynapseFlagRequest,
	type CreateSynapseProposalRequest,
	type ResolveSynapseFlagRequest,
	SYNAPSE_FLAG_KINDS,
	SYNAPSE_FLAG_STATUSES,
	type SynapseActor,
	type SynapseFlag,
	type SynapseFlagStatus,
	type SynapseProposal,
	type SynapseSpaceId,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";
import { assertTitle, titleKey } from "./markdown.js";
import {
	MAX_FLAGS_PER_PROPOSAL,
	MAX_REASON_LENGTH,
	publicSpaceId,
	type SynapseService,
} from "./synapse.js";

/** Flags one reporter may have open, so a loop that keeps flagging stops. */
export const MAX_OPEN_FLAGS = 50;
export const MAX_FLAG_PROBLEM_LENGTH = 2000;
export const MAX_FLAG_SUGGESTION_LENGTH = 5000;
export const MAX_FLAG_TASK_LENGTH = 500;
export const DEFAULT_FLAG_LIMIT = 50;
export const MAX_FLAG_LIMIT = 200;

/**
 * Who is asking. A curator (an agent with `synapse:curate`, or anyone using
 * the dashboard or the REST API) sees and settles every flag of the space;
 * anyone else only its own.
 */
export type FlagViewer = { actor: SynapseActor; curator: boolean };

const publicFlag = (flag: SynapseFlag): SynapseFlag => ({
	...flag,
	space: publicSpaceId(flag.space),
});

const notFound = () => new SynapseError("Flag not found.", 404);

/** A required or optional line of text, trimmed, within `max` characters. */
function text(value: unknown, what: string, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string")
		throw new SynapseError(`${what} must be a string.`);
	const trimmed = value.trim();
	if (trimmed.length > max)
		throw new SynapseError(
			`${what} is at most ${max.toLocaleString("en-US")} characters.`,
		);
	return trimmed || undefined;
}

/**
 * Reports that the shared knowledge is missing something or has it wrong,
 * filed by whoever noticed while doing the work, and settled by a curator.
 * A flag changes no note. A curator answers it with a proposal, which a
 * person approves like any other; a flag is resolved when that proposal is
 * approved and open again when it is rejected. See docs/SYNAPSE.md §19.
 */
export class SynapseFlags {
	constructor(private readonly synapse: SynapseService) {}

	private now() {
		return new Date(this.synapse.nowMs()).toISOString();
	}

	/** Files a flag about a workspace's shared space. Filing the same flag again returns the first. */
	async file(
		author: SynapseActor,
		request: CreateSynapseFlagRequest,
		space: SynapseSpaceId,
	): Promise<SynapseFlag> {
		if (!SYNAPSE_FLAG_KINDS.includes(request.kind))
			throw new SynapseError(
				`A flag's kind is one of ${SYNAPSE_FLAG_KINDS.join(", ")}.`,
			);
		const problem = text(
			request.problem,
			"What is missing or wrong",
			MAX_FLAG_PROBLEM_LENGTH,
		);
		if (!problem)
			throw new SynapseError("A flag says what is missing or wrong.");
		const title =
			request.title === undefined ? undefined : assertTitle(request.title);
		const suggestion = text(
			request.suggestion,
			"A suggestion",
			MAX_FLAG_SUGGESTION_LENGTH,
		);
		const task = text(request.task, "The task", MAX_FLAG_TASK_LENGTH);
		const { repository } = this.synapse;
		const open = await repository.listFlags(
			{ space, authorId: author.id, status: "open" },
			MAX_OPEN_FLAGS,
		);
		// A retried call, or an agent that meets the same gap twice, adds nothing.
		const same = open.find(
			(flag) =>
				flag.kind === request.kind &&
				flag.problem === problem &&
				(flag.title === undefined ? undefined : titleKey(flag.title)) ===
					(title === undefined ? undefined : titleKey(title)),
		);
		if (same) return publicFlag(same);
		if (open.length >= MAX_OPEN_FLAGS)
			throw new SynapseError(
				`You have ${MAX_OPEN_FLAGS} open flags. Wait for a curator to settle some before filing more.`,
			);
		const flag: SynapseFlag = {
			id: randomUUID(),
			space,
			kind: request.kind,
			...(title === undefined ? {} : { title }),
			problem,
			...(suggestion === undefined ? {} : { suggestion }),
			...(task === undefined ? {} : { task }),
			status: "open",
			author,
			createdAt: this.now(),
		};
		await repository.insertFlag(flag);
		return publicFlag(flag);
	}

	/**
	 * A space's flags, newest first: all of them for a curator, else the
	 * viewer's own. `offset` skips the newest ones, to read further back.
	 */
	async list(
		space: SynapseSpaceId,
		viewer: FlagViewer,
		filter: {
			status?: SynapseFlagStatus;
			mine?: boolean;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<SynapseFlag[]> {
		if (
			filter.status !== undefined &&
			!SYNAPSE_FLAG_STATUSES.includes(filter.status)
		)
			throw new SynapseError(
				`A flag's status is one of ${SYNAPSE_FLAG_STATUSES.join(", ")}.`,
			);
		const flags = await this.synapse.repository.listFlags(
			{
				space,
				status: filter.status,
				...(viewer.curator && !filter.mine
					? {}
					: { authorId: viewer.actor.id }),
			},
			Math.min(MAX_FLAG_LIMIT, Math.max(1, filter.limit ?? DEFAULT_FLAG_LIMIT)),
			Math.max(0, filter.offset ?? 0),
		);
		return flags.map(publicFlag);
	}

	count(space: SynapseSpaceId, status: SynapseFlagStatus): Promise<number> {
		return this.synapse.repository.countFlags({ space, status });
	}

	/** The flag, if it belongs to the space and the viewer may see it. */
	private async visible(id: string, space: SynapseSpaceId, viewer: FlagViewer) {
		const flag = await this.synapse.repository.getFlag(id);
		if (
			!flag ||
			flag.space !== space ||
			(!viewer.curator && flag.author.id !== viewer.actor.id)
		)
			throw notFound();
		return flag;
	}

	/**
	 * Settles a flag by hand: `resolved` when the knowledge was put right
	 * some other way, `dismissed` when nothing was to be done. A flag a
	 * pending proposal answers can be settled too; that proposal stays
	 * pending and no longer changes the flag.
	 */
	async resolve(
		id: string,
		request: ResolveSynapseFlagRequest,
		space: SynapseSpaceId,
		viewer: FlagViewer,
	): Promise<SynapseFlag> {
		if (request.status !== "resolved" && request.status !== "dismissed")
			throw new SynapseError("A flag is settled as resolved or dismissed.");
		const reason = text(request.reason, "The reason", MAX_REASON_LENGTH);
		if (!reason)
			throw new SynapseError(
				"Settling a flag needs a reason: what was done about it, or why nothing was.",
			);
		const flag = await this.visible(id, space, viewer);
		const settled = () =>
			new SynapseError(`This flag was already ${flag.status}.`, 409);
		if (flag.status !== "open" && flag.status !== "proposed") throw settled();
		const moved = await this.synapse.repository.setFlagState(
			id,
			{ status: ["open", "proposed"] },
			{
				status: request.status,
				...(flag.proposalId === undefined
					? {}
					: { proposalId: flag.proposalId }),
				resolvedAt: this.now(),
				resolvedBy: viewer.actor,
				resolution: reason,
			},
		);
		if (!moved)
			throw new SynapseError(
				"This flag was settled during your request. Reload it and try again.",
				409,
			);
		return publicFlag((await this.synapse.repository.getFlag(id)) ?? flag);
	}

	/**
	 * Files a proposal that answers flags. The flags must be open and the
	 * viewer's to settle; they become `proposed` and follow the proposal's
	 * decision. A flag someone else took in the meantime is left as it is:
	 * the proposal stands, and `flags` lists the ones it answers.
	 */
	async propose(
		request: CreateSynapseProposalRequest,
		ids: readonly string[],
		space: SynapseSpaceId,
		viewer: FlagViewer,
	): Promise<{ proposal: SynapseProposal; flags: SynapseFlag[] }> {
		const unique = [...new Set(ids)];
		if (unique.length > MAX_FLAGS_PER_PROPOSAL)
			throw new SynapseError(
				`A proposal answers at most ${MAX_FLAGS_PER_PROPOSAL} flags.`,
			);
		for (const id of unique) {
			const flag = await this.visible(id, space, viewer);
			if (flag.status !== "open")
				throw new SynapseError(
					flag.status === "proposed"
						? "A pending proposal already answers one of these flags."
						: `One of these flags was already ${flag.status}.`,
					409,
				);
		}
		const proposal = await this.synapse.propose(viewer.actor, request, space);
		const { repository } = this.synapse;
		const flags: SynapseFlag[] = [];
		for (const id of unique) {
			const moved = await repository.setFlagState(
				id,
				{ status: ["open"] },
				{ status: "proposed", proposalId: proposal.id },
			);
			const flag = moved ? await repository.getFlag(id) : null;
			if (flag) flags.push(publicFlag(flag));
		}
		return { proposal, flags };
	}
}
