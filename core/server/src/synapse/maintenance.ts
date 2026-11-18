import { createHash, randomUUID } from "node:crypto";
import type {
	DecideSynapseFindingsRequest,
	SynapseActor,
	SynapseDigest,
	SynapseFinding,
	SynapseFindingKind,
	SynapseFix,
	SynapseMaintenanceBatch,
	SynapseMaintenanceView,
	SynapseProperties,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { commitmentOf } from "./commitments.js";
import { SynapseError } from "./errors.js";
import {
	type CitedEvidence,
	evidenceState,
	parseEvidence,
	propertyTargets,
	standingOf,
} from "./evidence.js";
import { DATE_PATTERN, PROPERTY_LIST_MAX_ITEMS, titleKey } from "./markdown.js";
import type { MaintenanceRecord, StoredNote } from "./repository.js";
import {
	inheritsGlobal,
	MAX_BODY_LENGTH,
	publicSpaceId,
	type SynapseService,
} from "./synapse.js";
import { words } from "./text.js";

export const MAX_FINDINGS = 200;
const PAGE = 500;
/** Times a merge folds into the kept note when that note keeps changing. */
const MERGE_ATTEMPTS = 3;
const DAY_MS = 86_400_000;
/** Titles a digest line names before it says how many more there are. */
const NAMED = 5;
const SUPPORTING = new Set(["sources", "clippings", "meetings"]);
const KIND_ORDER: SynapseFindingKind[] = [
	"conflict",
	"duplicate",
	"stale",
	"unsupported",
];

export type MaintenanceOptions = {
	/** Time between a space's automatic runs. Default one day. */
	intervalMs?: number;
	/** A decision nobody reviewed for this many days is stale. Default 180. */
	staleDays?: number;
	/** How long a run holds its space. A crashed run is retried after this. */
	leaseMs?: number;
	/** Spaces one sweep runs, so a sweep stays short. */
	spacesPerSweep?: number;
	/** How often a sweep looks for due spaces at all. */
	checkMs?: number;
	log?: (message: string, details: Record<string, unknown>) => void;
};

/** What a run keeps of a note once its body has been read. */
type Light = Pick<
	StoredNote,
	| "id"
	| "title"
	| "titleKey"
	| "properties"
	| "categoryKeys"
	| "tagKeys"
	| "linkKeys"
	| "aliasKeys"
	| "createdAt"
	| "updatedAt"
> & { evidence: CitedEvidence[] };

/** A title as it is compared for duplicates: case, accents, punctuation, and a final plural do not count. */
export function nameKey(title: string): string {
	const parts = words(title.normalize("NFKD").replace(/\p{M}/gu, "")).flatMap(
		(item) => item.word.split(/['’.-]/).filter(Boolean),
	);
	const last = parts.at(-1);
	if (last && last.length > 3 && last.endsWith("s") && !last.endsWith("ss"))
		parts[parts.length - 1] = last.slice(0, -1);
	return parts.join(" ");
}

const findingId = (
	kind: SynapseFindingKind,
	keys: string[],
	fix: SynapseFix | null,
) =>
	createHash("sha256")
		.update([kind, ...[...keys].sort(), fix?.action ?? ""].join("\n"))
		.digest("hex")
		.slice(0, 16);

const daysBetween = (from: string, to: string) =>
	Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

const named = (titles: string[]) =>
	`${titles
		.slice(0, NAMED)
		.map((title) => `[[${title}]]`)
		.join(
			", ",
		)}${titles.length > NAMED ? `, and ${titles.length - NAMED} more` : ""}`;

/**
 * Background upkeep of a space's knowledge. A run reads the space's notes
 * and reports duplicate entities, conflicting statements, stale decisions,
 * and unsupported claims as one batch a person reviews, with a digest of
 * what changed and what needs them. Runs are durable: each holds a lease in
 * storage, so one process runs a space at a time and a crashed run is
 * retried by the next sweep. See docs/SYNAPSE.md §18.
 */
export class SynapseMaintenance {
	private readonly intervalMs: number;
	private readonly staleDays: number;
	private readonly leaseMs: number;
	private readonly spacesPerSweep: number;
	private readonly checkMs: number;
	private readonly working = new Set<Promise<unknown>>();
	private lastCheck = Number.NEGATIVE_INFINITY;
	private closing = false;

	constructor(
		private readonly synapse: SynapseService,
		private readonly options: MaintenanceOptions = {},
	) {
		this.intervalMs = options.intervalMs ?? DAY_MS;
		this.staleDays = options.staleDays ?? 180;
		this.leaseMs = options.leaseMs ?? 5 * 60_000;
		this.spacesPerSweep = options.spacesPerSweep ?? 2;
		this.checkMs = options.checkMs ?? 60_000;
	}

	private at(offsetMs = 0) {
		return new Date(this.synapse.nowMs() + offsetMs).toISOString();
	}

	/** Settles when no run started by this process is still working. */
	async idle(): Promise<void> {
		while (this.working.size) await Promise.allSettled([...this.working]);
	}
	/** Stops for shutdown: no new run starts, and the ones under way finish. */
	async close(): Promise<void> {
		this.closing = true;
		await this.idle();
	}

	/**
	 * Runs the spaces that are due: never run, changed since a run older
	 * than the interval, or not run for a week of intervals (stale decisions
	 * and overdue commitments appear without anyone writing). Called from
	 * the gateway's background sweep; it never throws.
	 */
	async sweep(): Promise<void> {
		const now = this.synapse.nowMs();
		if (this.closing || now - this.lastCheck < this.checkMs) return;
		this.lastCheck = now;
		const work = (async () => {
			const { repository } = this.synapse;
			const [records, runs] = await Promise.all([
				repository.listSpaceRecords(),
				repository.listMaintenanceRuns(),
			]);
			const last = new Map(runs.map((run) => [run.space, run.lastRunAt]));
			const due = this.at(-this.intervalMs);
			const overdue = this.at(-7 * this.intervalMs);
			const spaces = records
				.map((record) => ({ record, ran: last.get(record.id) ?? null }))
				.filter(
					({ record, ran }) =>
						ran === null ||
						(ran < due && record.updatedAt > ran) ||
						ran < overdue,
				)
				.sort((a, b) => (a.ran ?? "").localeCompare(b.ran ?? ""))
				.slice(0, this.spacesPerSweep);
			for (const { record } of spaces) {
				if (this.closing) return;
				await this.run(record.id).catch((error) =>
					this.options.log?.("Synapse maintenance failed.", {
						space: record.id,
						error,
					}),
				);
			}
		})().catch((error) =>
			this.options.log?.("Synapse maintenance could not start.", { error }),
		);
		this.working.add(work);
		await work.finally(() => this.working.delete(work));
	}

	/**
	 * Runs one space. Without `force`, only when it is due; returns null when
	 * it is not, or another process holds it.
	 */
	async run(
		space: SynapseSpaceId,
		force = false,
	): Promise<SynapseMaintenanceBatch | null> {
		const { repository } = this.synapse;
		const lease = { id: randomUUID(), until: this.at(this.leaseMs) };
		const claimed = await repository.claimMaintenance(
			space,
			lease,
			this.at(),
			// Every finished run is before the far future.
			force ? "9999" : this.at(-this.intervalMs),
		);
		if (!claimed) {
			if (force)
				throw new SynapseError(
					"Maintenance is already running for this space. Try again in a few minutes.",
					409,
				);
			return null;
		}
		try {
			// The run counts from when it started reading: a note written while
			// it reads is "changed since" for the run after it.
			const startedAt = this.at();
			const previous = await repository.getMaintenance(space);
			const batch = await this.inspect(space, previous, startedAt);
			// A run that outlived its lease lost the space to another runner: what
			// it found was not saved, so it is not handed back as the batch.
			if (
				!(await repository.finishMaintenance(space, lease.id, batch, startedAt))
			)
				throw new SynapseError(
					"This maintenance run took too long and another one replaced it. Reload the batch.",
					409,
				);
			return publicBatch(batch);
		} catch (error) {
			await repository.releaseMaintenance(space, lease.id).catch(() => {});
			throw error;
		}
	}

	async view(space: SynapseSpaceId): Promise<SynapseMaintenanceView> {
		const record = await this.synapse.repository.getMaintenance(space);
		return {
			batch: record?.batch ? publicBatch(record.batch) : null,
			intervalHours: Math.round(this.intervalMs / 3_600_000),
		};
	}

	/** Every note of the space itself, without its body. */
	private async read(space: SynapseSpaceId): Promise<Light[]> {
		const notes: Light[] = [];
		for (let offset = 0; ; offset += PAGE) {
			const page = await this.synapse.repository.findNotes(
				{ space },
				{ sort: { by: "titleKey", direction: "asc" }, limit: PAGE, offset },
			);
			for (const note of page)
				notes.push({
					id: note.id,
					title: note.title,
					titleKey: note.titleKey,
					properties: note.properties,
					categoryKeys: note.categoryKeys,
					tagKeys: note.tagKeys,
					linkKeys: note.linkKeys,
					aliasKeys: note.aliasKeys ?? [],
					createdAt: note.createdAt,
					updatedAt: note.updatedAt,
					evidence: parseEvidence(note.body),
				});
			if (page.length < PAGE) return notes;
		}
	}

	private async inspect(
		space: SynapseSpaceId,
		previous: MaintenanceRecord | null,
		startedAt: string,
	): Promise<SynapseMaintenanceBatch> {
		const notes = await this.read(space);
		const found: SynapseFinding[] = [];
		const seen = new Set<string>();
		const add = (
			kind: SynapseFindingKind,
			about: Light[],
			summary: string,
			fix: SynapseFix | null = null,
		) => {
			const id = findingId(
				kind,
				about.map((note) => note.titleKey),
				fix,
			);
			if (seen.has(id)) return;
			seen.add(id);
			found.push({
				id,
				kind,
				titles: about.map((note) => note.title),
				summary,
				fix,
				state: "open",
			});
		};
		const byKey = new Map(notes.map((note) => [note.titleKey, note]));
		const is = (note: Light | undefined, category: string) =>
			note?.categoryKeys.includes(category) ?? false;
		const today = this.synapse.today();

		this.duplicates(notes, add);

		// Decisions whose statuses contradict each other, or that nobody settled.
		const decisions = notes.filter((note) => is(note, "decisions"));
		const topics = new Map<string, Light[]>();
		for (const note of decisions) {
			const standing = standingOf(note.properties);
			if (standing.status !== "superseded")
				for (const title of standing.supersededBy) {
					const by = byKey.get(titleKey(title));
					add(
						"conflict",
						by ? [note, by] : [note],
						`[[${note.title}]] says [[${title}]] supersedes it, but it is still ${standing.status ?? "unmarked"}.`,
						is(by, "decisions")
							? { action: "supersede", title: note.title, by: title }
							: null,
					);
				}
			for (const title of standing.supersedes) {
				const old = byKey.get(titleKey(title));
				if (
					old &&
					is(old, "decisions") &&
					standingOf(old.properties).status !== "superseded"
				)
					add(
						"conflict",
						[old, note],
						`[[${note.title}]] says it supersedes [[${old.title}]], but that decision is not marked superseded.`,
						{ action: "supersede", title: old.title, by: note.title },
					);
			}
			if (standing.status === "disputed")
				add(
					"conflict",
					[note],
					`[[${note.title}]] is disputed. Settle it: mark it active again, or supersede it.`,
				);
			if (standing.status === "active") {
				const key = propertyTargets(note.properties.topics)
					.map(titleKey)
					.sort()
					.join("\n");
				if (key) topics.set(key, [...(topics.get(key) ?? []), note]);
				const reviewed = standing.reviewed ?? note.updatedAt.slice(0, 10);
				const age = daysBetween(reviewed, today);
				if (age > this.staleDays)
					add(
						"stale",
						[note],
						`[[${note.title}]] was last reviewed on ${reviewed}, ${age} days ago. Confirm it still stands, or supersede it.`,
						{ action: "confirm", title: note.title },
					);
			}
		}
		for (const group of topics.values())
			if (group.length > 1)
				add(
					"conflict",
					group.slice(0, NAMED),
					`${plural(group.length, "active decision")} cover the same topics: ${named(group.map((note) => note.title))}. Check that they agree, or supersede the older ones.`,
				);
		for (const note of notes)
			for (const title of propertyTargets(note.properties.contradicts)) {
				const other = byKey.get(titleKey(title));
				add(
					"conflict",
					other ? [note, other] : [note],
					`[[${note.title}]] says it contradicts [[${title}]].`,
				);
			}

		for (const note of notes.filter((item) => is(item, "commitments"))) {
			const commitment = commitmentOf({ ...note, space, revision: 0 }, today);
			if (commitment.overdue)
				add(
					"stale",
					[note],
					`[[${note.title}]] was due ${commitment.due} and is still ${commitment.status}${commitment.owner.length ? ` (owner: ${commitment.owner.join(", ")})` : ""}.`,
				);
		}

		await this.unsupported(space, notes, byKey, add);

		const dismissed = new Set(previous?.dismissed ?? []);
		const findings = found
			.filter((finding) => !dismissed.has(finding.id))
			.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
			.slice(0, MAX_FINDINGS);
		return {
			id: randomUUID(),
			space,
			createdAt: startedAt,
			revision: 1,
			findings,
			digest: await this.digest(space, previous, findings, notes.length),
		};
	}

	/** Notes that look like the same thing under two titles. */
	private duplicates(
		notes: Light[],
		add: (
			kind: SynapseFindingKind,
			about: Light[],
			summary: string,
			fix: SynapseFix | null,
		) => void,
	) {
		const candidates = notes.filter(
			(note) =>
				!note.tagKeys.includes("categories") &&
				!note.tagKeys.includes("daily") &&
				!DATE_PATTERN.test(note.title),
		);
		// Union-find over the reasons two notes may be one.
		const parent = new Map(candidates.map((note) => [note.id, note.id]));
		const why = new Map<string, string>();
		const find = (id: string): string => {
			let top = id;
			while (parent.get(top) !== top) top = parent.get(top) as string;
			parent.set(id, top);
			return top;
		};
		const groups = new Map<string, Light>();
		const join = (key: string, note: Light, reason: string) => {
			const other = groups.get(key);
			if (!other) {
				groups.set(key, note);
				return;
			}
			const [a, b] = [find(other.id), find(note.id)];
			if (a === b) return;
			parent.set(b, a);
			if (!why.has(a)) why.set(a, why.get(b) ?? reason);
		};
		const text = (value: unknown) =>
			typeof value === "string" ? value.trim().toLowerCase() : "";
		for (const note of candidates) {
			const name = nameKey(note.title);
			if (name) join(`name\n${name}`, note, "the same name");
			for (const alias of note.aliasKeys ?? []) {
				const key = nameKey(alias);
				if (key) join(`name\n${key}`, note, "a name one lists as an alias");
			}
			const category = note.categoryKeys[0] ?? "";
			if (text(note.properties.email))
				join(
					`email\n${text(note.properties.email)}`,
					note,
					"the same email address",
				);
			if (text(note.properties.url))
				join(
					`url\n${category}\n${text(note.properties.url)}`,
					note,
					"the same address",
				);
		}
		const backlinks = new Map<string, number>();
		for (const note of notes)
			for (const key of note.linkKeys)
				backlinks.set(key, (backlinks.get(key) ?? 0) + 1);
		const members = new Map<string, Light[]>();
		for (const note of candidates) {
			const top = find(note.id);
			members.set(top, [...(members.get(top) ?? []), note]);
		}
		for (const [top, group] of members) {
			if (group.length < 2) continue;
			// The better-linked note stays; the older one on a tie.
			const [into, ...rest] = [...group].sort(
				(a, b) =>
					(backlinks.get(b.titleKey) ?? 0) - (backlinks.get(a.titleKey) ?? 0) ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.titleKey.localeCompare(b.titleKey),
			);
			for (const from of rest) {
				const differing = Object.keys(from.properties).filter((key) => {
					const [mine, theirs] = [from.properties[key], into.properties[key]];
					return (
						!["created", "categories", "aliases"].includes(key) &&
						typeof mine === "string" &&
						typeof theirs === "string" &&
						mine.trim() !== "" &&
						theirs.trim() !== "" &&
						mine.trim().toLowerCase() !== theirs.trim().toLowerCase()
					);
				});
				add(
					"duplicate",
					[into, from],
					`[[${from.title}]] and [[${into.title}]] look like one thing: they have ${why.get(top) ?? "the same name"}.${
						differing.length
							? ` They disagree on ${differing.join(", ")}; merging keeps what [[${into.title}]] says.`
							: ""
					}`,
					{ action: "merge", from: from.title, into: into.title },
				);
			}
		}
	}

	/** Claims with nothing behind them, and evidence its source no longer bears out. */
	private async unsupported(
		space: SynapseSpaceId,
		notes: Light[],
		byKey: Map<string, Light>,
		add: (kind: SynapseFindingKind, about: Light[], summary: string) => void,
	) {
		const claims = notes.filter((note) => {
			const standing = standingOf(note.properties);
			if (!standing.current) return false;
			if (note.categoryKeys.includes("answers")) return !standing.draft;
			return (
				note.categoryKeys.includes("decisions") ||
				note.categoryKeys.includes("evergreen")
			);
		});
		for (const note of claims) {
			const cites =
				note.evidence.length > 0 ||
				["source", "sources", "url"].some(
					(key) => propertyTargets(note.properties[key]).length > 0,
				) ||
				note.linkKeys.some((key) =>
					byKey
						.get(key)
						?.categoryKeys.some((category) => SUPPORTING.has(category)),
				);
			if (!cites)
				add(
					"unsupported",
					[note],
					`[[${note.title}]] cites nothing: no evidence line, source, or meeting note says where it came from.`,
				);
		}
		// Check what is quoted against the sources as they stand now.
		const cited = notes.filter((note) => note.evidence.length);
		const wanted = [
			...new Set(
				cited.flatMap((note) =>
					note.evidence.map((item) => titleKey(item.source)),
				),
			),
		];
		const bodies = new Map<string, string>();
		for (let offset = 0; offset < wanted.length; offset += 100) {
			const titleKeys = wanted.slice(offset, offset + 100);
			for (const source of await this.synapse.find(
				{ space, titleKeys },
				{ sort: { by: "titleKey", direction: "asc" }, limit: titleKeys.length },
			))
				bodies.set(source.titleKey, source.body);
		}
		for (const note of cited)
			for (const item of note.evidence) {
				const state = evidenceState(
					item.passage,
					bodies.get(titleKey(item.source)) ?? null,
				);
				if (state === "missing")
					add(
						"unsupported",
						[note],
						`[[${note.title}]] cites [[${item.source}]], which does not exist.`,
					);
				else if (state === "changed")
					add(
						"unsupported",
						[note],
						`[[${note.title}]] quotes [[${item.source}]], which no longer contains the passage${item.revision ? ` it had at revision ${item.revision}` : ""}. Check the source's history.`,
					);
			}
	}

	private async digest(
		space: SynapseSpaceId,
		previous: MaintenanceRecord | null,
		findings: SynapseFinding[],
		noteCount: number,
	): Promise<SynapseDigest> {
		const { repository } = this.synapse;
		const since = previous?.lastRunAt ?? null;
		const changed: string[] = [];
		if (since === null)
			changed.push(`First run: ${plural(noteCount, "note")} checked.`);
		else {
			const revisions = await repository.revisionsSince(space, since, 1000);
			// A note counts once, by what last happened to it.
			const latest = new Map<string, { change: string; title: string }>();
			const created = new Set<string>();
			for (const revision of revisions) {
				if (revision.by.kind === "system") continue;
				if (!latest.has(revision.noteId))
					latest.set(revision.noteId, {
						change: revision.change,
						title: revision.title,
					});
				if (revision.change === "created") created.add(revision.noteId);
			}
			const titles = (change: string) =>
				[...latest.entries()]
					.filter(([id, item]) =>
						change === "created"
							? item.change !== "deleted" && created.has(id)
							: change === "updated"
								? item.change === "updated" && !created.has(id)
								: item.change === "deleted",
					)
					.map(([, item]) => item.title)
					.sort((a, b) => a.localeCompare(b));
			for (const [change, verb] of [
				["created", "created"],
				["updated", "changed"],
				["deleted", "deleted"],
			]) {
				const list = titles(change);
				if (list.length)
					changed.push(
						`${plural(list.length, "note")} ${verb}: ${named(list)}.`,
					);
			}
			if (inheritsGlobal(space)) {
				const decided = (await repository.recentDecisions(space, 100)).filter(
					(proposal) => (proposal.decidedAt ?? "") > since,
				);
				const approved = decided.filter(
					(proposal) => proposal.status === "approved",
				).length;
				if (decided.length)
					changed.push(
						`${plural(approved, "proposal")} approved, ${decided.length - approved} rejected.`,
					);
			}
			const applied = (previous?.batch?.findings ?? []).filter(
				(finding) => finding.state === "applied",
			).length;
			if (applied)
				changed.push(
					`${plural(applied, "maintenance fix", "maintenance fixes")} applied.`,
				);
			if (!changed.length) changed.push("Nothing changed since the last run.");
		}
		const needsYou: string[] = [];
		const count = (kind: SynapseFindingKind) =>
			findings.filter((finding) => finding.kind === kind).length;
		const say = (kind: SynapseFindingKind, text: (total: number) => string) => {
			const total = count(kind);
			if (total) needsYou.push(text(total));
		};
		say(
			"conflict",
			(total) => `${plural(total, "conflict")} between decisions to settle.`,
		);
		say(
			"duplicate",
			(total) => `${plural(total, "possible duplicate")} to merge or dismiss.`,
		);
		say(
			"stale",
			(total) =>
				`${plural(total, "stale decision or overdue commitment", "stale decisions or overdue commitments")} to confirm or close.`,
		);
		say(
			"unsupported",
			(total) =>
				`${plural(total, "claim")} without a source that bears it out.`,
		);
		if (inheritsGlobal(space)) {
			const pending = await repository.countProposals({
				space,
				status: "pending",
			});
			if (pending)
				needsYou.push(
					`${plural(pending, "proposal waits", "proposals wait")} for a decision.`,
				);
		}
		if (!needsYou.length) needsYou.push("Nothing needs you.");
		return { since, changed, needsYou };
	}

	/**
	 * A person's review of some of a batch's findings: apply their fixes, or
	 * dismiss them for good. A fix that fails leaves its finding open with
	 * the reason, and the rest still apply.
	 */
	async decide(
		space: SynapseSpaceId,
		request: DecideSynapseFindingsRequest,
		actor: SynapseActor,
	): Promise<SynapseMaintenanceBatch> {
		const record = await this.synapse.repository.getMaintenance(space);
		const batch = record?.batch;
		if (!batch)
			throw new SynapseError("This space has no maintenance batch yet.", 404);
		const stale = () =>
			new SynapseError(
				"This batch changed while you were reviewing it. Reload it and try again.",
				409,
			);
		if (request.revision !== undefined && request.revision !== batch.revision)
			throw stale();
		if (request.decision !== "apply" && request.decision !== "dismiss")
			throw new SynapseError("Findings are applied or dismissed.");
		const ids = [...new Set(Array.isArray(request.ids) ? request.ids : [])];
		if (!ids.length) throw new SynapseError("Choose at least one finding.");
		const chosen = ids.map((id) => {
			const finding = batch.findings.find((item) => item.id === id);
			if (!finding)
				throw new SynapseError("That finding is not in this batch.", 404);
			return finding;
		});
		if (request.decision === "apply") {
			const manual = chosen.find(
				(finding) => finding.state === "open" && !finding.fix,
			);
			if (manual)
				throw new SynapseError(
					`"${manual.titles.join('", "')}" has no automatic fix. Edit the notes, or dismiss the finding.`,
				);
		}
		const dismissed: string[] = [];
		for (const finding of chosen) {
			if (finding.state !== "open") continue;
			delete finding.detail;
			if (request.decision === "dismiss") {
				finding.state = "dismissed";
				dismissed.push(finding.id);
			} else {
				try {
					await this.fix(space, finding.fix as SynapseFix, actor);
					finding.state = "applied";
				} catch (error) {
					if (!(error instanceof SynapseError)) throw error;
					finding.detail = error.message;
					continue;
				}
			}
			finding.decidedAt = this.at();
			finding.decidedBy = actor;
		}
		const next = { ...batch, revision: batch.revision + 1 };
		if (
			!(await this.synapse.repository.reviewMaintenance(
				space,
				next,
				batch.revision,
				dismissed,
			))
		)
			throw stale();
		return publicBatch(next);
	}

	private async fix(
		space: SynapseSpaceId,
		fix: SynapseFix,
		actor: SynapseActor,
	) {
		if (fix.action === "confirm") {
			await this.synapse.updateNote(
				space,
				fix.title,
				{ properties: { reviewed: this.synapse.today() } },
				actor,
			);
			return;
		}
		if (fix.action === "supersede") {
			await this.synapse.setDecisionStatus(
				space,
				fix.title,
				{
					status: "superseded",
					supersededBy: fix.by,
					reason: "Applied from a maintenance review.",
				},
				actor,
			);
			return;
		}
		await this.merge(space, fix.from, fix.into, actor);
	}

	/**
	 * Folds one note into another: its body goes under a heading in the
	 * kept note, its properties fill what the kept note lacks, its title
	 * becomes an alias, links to it point at the kept note, and it is
	 * deleted. Its history keeps what it held.
	 */
	private async merge(
		space: SynapseSpaceId,
		fromTitle: string,
		intoTitle: string,
		actor: SynapseActor,
	) {
		const { repository } = this.synapse;
		const [from, into] = await Promise.all([
			repository.getNote(space, titleKey(fromTitle)),
			repository.getNote(space, titleKey(intoTitle)),
		]);
		const gone = (title: string) =>
			new SynapseError(
				`"${title}" no longer exists, so there is nothing to merge.`,
				409,
			);
		if (!from) throw gone(fromTitle);
		if (!into) throw gone(intoTitle);
		const merged = (target: StoredNote) => {
			const own = target.body.trimEnd();
			const body =
				from.body.trim() === ""
					? target.body
					: `${own}${own ? "\n\n" : ""}## Merged from ${from.title}\n${from.body.trim()}`;
			if (body.length > MAX_BODY_LENGTH)
				throw new SynapseError(
					`"${target.title}" would be too long with "${from.title}" merged into it. Merge them by hand.`,
				);
			const properties: SynapseProperties = { ...target.properties };
			for (const [key, value] of Object.entries(from.properties)) {
				const mine = properties[key];
				if (Array.isArray(mine) && Array.isArray(value))
					properties[key] = [...new Set([...mine, ...value])].slice(
						0,
						PROPERTY_LIST_MAX_ITEMS,
					);
				else if (mine === undefined || mine === null || mine === "")
					properties[key] = value;
			}
			const aliases = propertyTargets(properties.aliases);
			if (!aliases.some((alias) => titleKey(alias) === from.titleKey))
				properties.aliases = [...aliases, from.title].slice(
					0,
					PROPERTY_LIST_MAX_ITEMS,
				);
			return { body, properties };
		};
		// Checked before anything is deleted.
		merged(into);
		// The source goes first, and only at the revision read here: what is
		// folded in is then exactly what was deleted, and an edit made to it
		// meanwhile stops the merge instead of being lost. From here its
		// content lives in this call and in its history.
		await this.synapse.deleteNote(space, from.title, actor, from.revision);
		try {
			let target = into;
			for (let attempt = 0; ; attempt++) {
				try {
					await this.synapse.updateNote(
						space,
						target.title,
						{
							...merged(target),
							replaceProperties: true,
							revision: target.revision,
						},
						actor,
					);
					break;
				} catch (error) {
					const current = await repository.getNote(space, into.titleKey);
					if (
						!(error instanceof SynapseError && error.statusCode === 409) ||
						attempt + 1 >= MERGE_ATTEMPTS ||
						!current
					)
						throw error;
					// Someone edited the kept note: fold into what it says now.
					target = current;
				}
			}
		} catch (error) {
			// The kept note could not take it: put the source back as it was.
			await this.synapse
				.createNote(
					space,
					{ title: from.title, body: from.body, properties: from.properties },
					actor,
				)
				.catch(() => {});
			throw error;
		}
		await this.synapse.relink(space, from.title, into.title, actor);
	}
}

/** A batch as a request sees it: every workspace calls its shared space `shared`. */
const publicBatch = (
	batch: SynapseMaintenanceBatch,
): SynapseMaintenanceBatch => ({
	...batch,
	space: publicSpaceId(batch.space),
});
