import {
	type CreateSynapseCommitmentRequest,
	SYNAPSE_COMMITMENT_STATUSES,
	type SynapseActor,
	type SynapseCommitment,
	type SynapseCommitmentEvent,
	type SynapseCommitmentStatus,
	type SynapseProperties,
	type SynapseSpaceId,
} from "@autonomo.us/common";
import { SynapseError } from "./errors.js";
import { appendSectionLine, propertyTargets } from "./evidence.js";
import {
	assertTitle,
	extractLinks,
	linkTarget,
	PROPERTY_LIST_MAX_ITEMS,
	titleKey,
	titleProblem,
} from "./markdown.js";
import type { StoredNote } from "./repository.js";
import { publicSpaceId, type SynapseService } from "./synapse.js";
import { localTime, validDate } from "./time.js";

export const COMMITMENTS_KEY = "commitments";
export const ACTIVITY_HEADING = "Activity";
export const MAX_COMMITMENTS = 500;
const MAX_EVIDENCE_LENGTH = 500;
const MAX_EVENT_TEXT = 1000;
const WRITE_ATTEMPTS = 3;
const EVENT_KINDS: readonly SynapseCommitmentEvent["kind"][] = [
	"message",
	"meeting",
	"transcript",
	"confirmation",
	"calendar",
];

const label = (status: SynapseCommitmentStatus) =>
	`${status[0].toUpperCase()}${status.slice(1)}`;

/** A commitment note read as a record. `today` decides whether it is overdue. */
export function commitmentOf(
	note: Pick<
		StoredNote,
		"title" | "space" | "properties" | "updatedAt" | "revision"
	>,
	today: string,
): SynapseCommitment {
	const values = propertyTargets(note.properties.status).map((item) =>
		item.toLowerCase(),
	);
	const status =
		// The last status listed is the latest one written.
		[...values]
			.reverse()
			.find((item): item is SynapseCommitmentStatus =>
				(SYNAPSE_COMMITMENT_STATUSES as readonly string[]).includes(item),
			) ?? "open";
	const due =
		typeof note.properties.due === "string" && validDate(note.properties.due)
			? note.properties.due
			: null;
	return {
		title: note.title,
		space: publicSpaceId(note.space),
		owner: propertyTargets(note.properties.owner),
		due,
		status,
		project: propertyTargets(note.properties.project),
		evidence: propertyTargets(note.properties.evidence),
		overdue:
			(status === "open" || status === "blocked") &&
			due !== null &&
			due < today,
		updatedAt: note.updatedAt,
		revision: note.revision,
	};
}

/** Overdue first, then the soonest due, then the undated, by title. */
export function byUrgency(a: SynapseCommitment, b: SynapseCommitment): number {
	return (
		Number(b.overdue) - Number(a.overdue) ||
		(a.due ?? "9999").localeCompare(b.due ?? "9999") ||
		a.title.localeCompare(b.title)
	);
}

const list = (value: string | string[] | undefined) =>
	(Array.isArray(value) ? value : value === undefined ? [] : [value])
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);

/** A name as a link, whether it came bare or already linked. */
const linked = (name: string) =>
	/^\[\[[^[\]]+\]\]$/.test(name) ? name : `[[${name}]]`;

const STATUS_WORDS: Array<[string, SynapseCommitmentStatus]> = [
	["reopened|re-opened|unblocked|open again", "open"],
	["blocked|stuck", "blocked"],
	["cancelled|canceled|dropped|called off", "cancelled"],
	["done|complete|completed|finished|shipped|delivered", "done"],
];
const STATUS_PATTERNS = STATUS_WORDS.map(
	([words, status]) =>
		[
			// After the link: "is done", ": blocked on legal", "now shipped".
			new RegExp(
				`^(?:(?:is|are|was|were|has been|have been|got)\\s+)?[:\\-–—=>→\\s]*(?:(?:now|been|marked|as)\\s+)*(?:${words})(?![\\p{L}\\p{N}])`,
				"iu",
			),
			// Before the link: "Done:", "Marking blocked -".
			new RegExp(
				`^(?:[-*+>\\s]|\\p{Extended_Pictographic})*(?:(?:mark|marking|marked)\\s+)?(?:${words})\\s*[:\\-–—]?$`,
				"iu",
			),
			status,
		] as const,
);

/**
 * The status a line of a message states for the commitment it links, or
 * null. The words must sit right beside the link, as in "[[Ship the pricing
 * page]] is done" or "Blocked: [[Ship the pricing page]]", so that "will be
 * done by Friday" and "is it done?" change nothing.
 */
export function statedStatus(
	line: string,
	title: string,
): SynapseCommitmentStatus | null {
	const text = line.trim();
	if (text.endsWith("?")) return null;
	const key = titleKey(title);
	const link = [...text.matchAll(/!?\[\[([^[\]\n]*)\]\]/g)].find((match) => {
		const target = linkTarget(match[1]);
		return target !== null && titleKey(target) === key;
	});
	if (!link) return null;
	const before = text.slice(0, link.index).trim();
	const after = text.slice(link.index + link[0].length).trim();
	for (const [afterLink, beforeLink, status] of STATUS_PATTERNS)
		if (afterLink.test(after) || beforeLink.test(before)) return status;
	return null;
}

/** A message posted in a channel, as commitments see it. */
export type CommitmentMessage = {
	channelId: string;
	channelName: string;
	seq: number;
	body: string;
	author: { kind: "user" | "agent" | "api-token"; id: string; name: string };
};

/** How a commitment cites a channel message. */
export const messageReference = (message: { channelId: string; seq: number }) =>
	`channel:${message.channelId}#${message.seq}`;

/**
 * Commitments: obligations kept as notes in the Commitments category, each
 * with an owner, a due date, a status, a project, and the message or meeting
 * note it rests on. What happens to one is appended to its `## Activity`
 * section. See docs/SYNAPSE.md §17.
 */
export class SynapseCommitments {
	constructor(private readonly synapse: SynapseService) {}

	/** A space's commitments, the most urgent first. */
	async list(
		space: SynapseSpaceId,
		filter: {
			status?: SynapseCommitmentStatus;
			owner?: string;
			project?: string;
			overdue?: boolean;
		} = {},
	): Promise<SynapseCommitment[]> {
		const today = this.synapse.today();
		const notes = await this.synapse.find(
			{ space, categoryKey: COMMITMENTS_KEY },
			{ sort: { by: "updatedAt", direction: "desc" }, limit: MAX_COMMITMENTS },
		);
		const named = (values: string[], name: string) =>
			values.some((value) => titleKey(value) === titleKey(name.trim()));
		return notes
			.map((note) => commitmentOf(note, today))
			.filter(
				(item) =>
					(filter.status === undefined || item.status === filter.status) &&
					(filter.owner === undefined || named(item.owner, filter.owner)) &&
					(filter.project === undefined ||
						named(item.project, filter.project)) &&
					(filter.overdue === undefined || item.overdue === filter.overdue),
			)
			.sort(byUrgency);
	}

	/** Evidence as it is stored: a link when it names a note of the space, else the reference as given. */
	private async reference(space: SynapseSpaceId, evidence: unknown) {
		const text = typeof evidence === "string" ? evidence.trim() : "";
		if (!text)
			throw new SynapseError(
				"A commitment rests on something: give the message or the note where it was said (evidence).",
			);
		if (text.length > MAX_EVIDENCE_LENGTH)
			throw new SynapseError(
				`Evidence is at most ${MAX_EVIDENCE_LENGTH} characters: a note title, a link, or a message reference.`,
			);
		if (/^\[\[[^[\]]+\]\]$/.test(text)) return text;
		return !titleProblem(text) && (await this.synapse.findNote(space, text))
			? `[[${text}]]`
			: text;
	}

	async create(
		space: SynapseSpaceId,
		request: CreateSynapseCommitmentRequest,
		actor: SynapseActor,
	): Promise<SynapseCommitment> {
		const title = assertTitle(request.title);
		const owner = list(request.owner);
		if (!owner.length)
			throw new SynapseError("A commitment needs an owner: who owes it.");
		if (request.due !== undefined && !validDate(request.due))
			throw new SynapseError("A due date is written YYYY-MM-DD.");
		const evidence = await this.reference(space, request.evidence);
		const line = this.line("Promised", "created", evidence, actor, "");
		await this.synapse.createNote(
			space,
			{
				title,
				template: "Commitments",
				properties: {
					owner: owner.map(linked),
					due: request.due ?? null,
					project: list(request.project).map(linked),
					evidence: [evidence],
				},
				body: appendSectionLine(
					typeof request.body === "string" ? request.body.trim() : "",
					ACTIVITY_HEADING,
					line,
				),
			},
			actor,
		);
		return this.get(space, title);
	}

	private async note(space: SynapseSpaceId, title: string) {
		const note = await this.synapse.findNote(space, title);
		if (!note)
			throw new SynapseError(`No note titled "${title}" in this space.`, 404);
		if (!note.categoryKeys.includes(COMMITMENTS_KEY))
			throw new SynapseError(
				`"${note.title}" is not a commitment: only notes in the Commitments category take these updates.`,
			);
		return note;
	}

	async get(space: SynapseSpaceId, title: string): Promise<SynapseCommitment> {
		return commitmentOf(await this.note(space, title), this.synapse.today());
	}

	private line(
		what: string,
		kind: string,
		evidence: string | null,
		actor: SynapseActor,
		text: string,
	) {
		const now = this.synapse.nowMs();
		const stamp = `${this.synapse.today()} ${localTime(now, this.synapse.timeZone)}`;
		const said = text.replace(/\s+/g, " ").trim().slice(0, MAX_EVENT_TEXT);
		return `- ${stamp} ${what} (${[kind, evidence, actor.name].filter(Boolean).join(", ")})${said ? `: ${said}` : ""}`;
	}

	/**
	 * Records something that happened to a commitment. A status change is a
	 * decision, so it needs where it was said: a message, a meeting note, or a
	 * transcript as evidence, or a person's own confirmation. A calendar entry
	 * is scheduling context and may only move the due date.
	 */
	async record(
		space: SynapseSpaceId,
		title: string,
		event: SynapseCommitmentEvent,
		actor: SynapseActor,
	): Promise<SynapseCommitment> {
		if (!EVENT_KINDS.includes(event.kind))
			throw new SynapseError(
				"An event is a message, meeting, transcript, confirmation, or calendar entry.",
			);
		if (
			event.status !== undefined &&
			!SYNAPSE_COMMITMENT_STATUSES.includes(event.status)
		)
			throw new SynapseError(
				"A commitment is open, blocked, done, or cancelled.",
			);
		if (event.due !== undefined && !validDate(event.due))
			throw new SynapseError("A due date is written YYYY-MM-DD.");
		const text = typeof event.text === "string" ? event.text : "";
		if (event.status === undefined && event.due === undefined && !text.trim())
			throw new SynapseError(
				"Say what happened: a new status, a new due date, or a line of text.",
			);
		if (event.kind === "calendar" && event.status !== undefined)
			throw new SynapseError(
				"A calendar entry is scheduling context: it can move the due date, not the status. A status change needs a message, a meeting note, a transcript, or a person's confirmation.",
			);
		const evidence =
			event.evidence === undefined || event.evidence.trim() === ""
				? null
				: await this.reference(space, event.evidence);
		if (event.status !== undefined && !evidence) {
			if (event.kind !== "confirmation")
				throw new SynapseError(
					`A status change from a ${event.kind} needs evidence: the note or message where it was said.`,
				);
			if (actor.kind !== "user")
				throw new SynapseError(
					"A confirmation comes from a person. Cite the message or note where they confirmed it (evidence).",
				);
		}
		for (let attempt = 0; ; attempt++) {
			const note = await this.note(space, title);
			const current = commitmentOf(note, this.synapse.today());
			// A retried event that already took effect changes nothing.
			if (
				evidence &&
				current.evidence.some(
					(item) => titleKey(item) === titleKey(bare(evidence)),
				) &&
				(event.status === undefined || event.status === current.status) &&
				(event.due === undefined || event.due === current.due)
			)
				return current;
			const changes = [
				event.status !== undefined && event.status !== current.status
					? `Status: ${label(current.status)} to ${label(event.status)}`
					: null,
				event.due !== undefined && event.due !== current.due
					? `Due: ${current.due ?? "no date"} to ${event.due}`
					: null,
			].filter(Boolean);
			const properties: SynapseProperties = {};
			if (event.status !== undefined)
				properties.status = [`[[${label(event.status)}]]`];
			if (event.due !== undefined) properties.due = event.due;
			if (evidence) {
				const stored = Array.isArray(note.properties.evidence)
					? note.properties.evidence
					: [];
				if (!stored.includes(evidence))
					// The oldest references give way once the list is full.
					properties.evidence = [...stored, evidence].slice(
						-PROPERTY_LIST_MAX_ITEMS,
					);
			}
			try {
				await this.synapse.updateNote(
					space,
					note.title,
					{
						properties,
						body: appendSectionLine(
							note.body,
							ACTIVITY_HEADING,
							this.line(
								changes.length ? changes.join("; ") : "Noted",
								event.kind,
								evidence,
								actor,
								text,
							),
						),
						revision: note.revision,
					},
					actor,
				);
				return this.get(space, note.title);
			} catch (error) {
				if (
					!(error instanceof SynapseError && error.statusCode === 409) ||
					attempt + 1 >= WRITE_ATTEMPTS
				)
					throw error;
			}
		}
	}

	/**
	 * A message was posted in a channel. A person's message that links a
	 * commitment of the workspace's shared space, as `[[its title]]`, is
	 * recorded on it; a status word on the same line ("done", "blocked",
	 * "cancelled", "reopened") changes its status, with the message as the
	 * evidence. An agent's or token's message is information, not a
	 * confirmation, so it is recorded without changing the status.
	 */
	async onMessage(
		space: SynapseSpaceId,
		message: CommitmentMessage,
	): Promise<SynapseCommitment[]> {
		const targets = extractLinks([message.body]);
		if (!targets.length) return [];
		const reference = messageReference(message);
		const actor: SynapseActor = {
			kind: message.author.kind,
			id: message.author.id,
			name: message.author.name,
		};
		const lines = message.body.split("\n");
		const updated: SynapseCommitment[] = [];
		for (const target of targets.slice(0, 20)) {
			// The workspace's own notes only: a message does not change Global.
			const note = await this.synapse.repository.getNote(
				space,
				titleKey(target),
			);
			if (!note?.categoryKeys.includes(COMMITMENTS_KEY)) continue;
			const line =
				lines.find((item) =>
					extractLinks([item]).some((link) => titleKey(link) === note.titleKey),
				) ?? "";
			const status =
				message.author.kind === "user" ? statedStatus(line, note.title) : null;
			try {
				updated.push(
					await this.record(
						space,
						note.title,
						{
							kind: "message",
							evidence: reference,
							text: `In #${message.channelName}: ${line.trim() || message.body.trim()}`,
							...(status ? { status } : {}),
						},
						actor,
					),
				);
			} catch (error) {
				// One commitment that cannot take the message does not stop the rest.
				if (!(error instanceof SynapseError)) throw error;
			}
		}
		return updated;
	}
}

/** A reference without its link brackets. */
const bare = (reference: string) =>
	reference.replace(/^\[\[(.*)\]\]$/s, "$1").trim();
