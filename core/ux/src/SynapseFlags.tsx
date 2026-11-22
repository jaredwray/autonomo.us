import {
	SYNAPSE_FLAG_KINDS,
	SYNAPSE_FLAG_STATUSES,
	type SynapseFlag,
	type SynapseFlagKind,
	type SynapseFlagStatus,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createSynapseFlag,
	fetchSynapseFlags,
	resolveSynapseFlag,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { noteHash, synapseHash } from "./synapse-route.js";
import { failureMessage, shortDate } from "./synapse-shared.js";

const KIND_LABEL: Record<SynapseFlagKind, string> = {
	missing: "Missing",
	wrong: "Wrong",
	outdated: "Out of date",
};
const KIND_HINT: Record<SynapseFlagKind, string> = {
	missing: "Something agents need is not written down",
	wrong: "Something written down is not true",
	outdated: "Something written down was true once",
};
/** Flags loaded at a time; older ones are a button away. */
export const FLAG_PAGE = 50;
const STATUS_LABEL: Record<SynapseFlagStatus, string> = {
	open: "Open",
	proposed: "Proposed",
	resolved: "Resolved",
	dismissed: "Dismissed",
};

function NewFlagForm({
	onClose,
	onFiled,
}: {
	onClose(): void;
	onFiled(flag: SynapseFlag): void;
}) {
	const [kind, setKind] = useState<SynapseFlagKind>("missing");
	const [title, setTitle] = useState("");
	const [problem, setProblem] = useState("");
	const [suggestion, setSuggestion] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			onFiled(
				await createSynapseFlag({
					kind,
					problem: problem.trim(),
					...(title.trim() ? { title: title.trim() } : {}),
					...(suggestion.trim() ? { suggestion: suggestion.trim() } : {}),
				}),
			);
		} catch (cause) {
			setError(failureMessage(cause, "Could not file the flag."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="card token-form"
			aria-labelledby="synapse-flag-new-heading"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<h2 id="synapse-flag-new-heading" tabIndex={-1} ref={heading}>
				New flag
			</h2>
			<div className="form-field">
				<label htmlFor="synapse-flag-kind">What is the matter</label>
				<Dropdown
					id="synapse-flag-kind"
					value={kind}
					disabled={busy}
					onValueChange={(value) => setKind(value as SynapseFlagKind)}
				>
					{SYNAPSE_FLAG_KINDS.map((item) => (
						<option key={item} value={item}>
							{`${KIND_LABEL[item]}: ${KIND_HINT[item].toLowerCase()}`}
						</option>
					))}
				</Dropdown>
			</div>
			<div className="form-field">
				<label htmlFor="synapse-flag-title">Note (optional)</label>
				<input
					id="synapse-flag-title"
					maxLength={200}
					value={title}
					disabled={busy}
					placeholder="The shared note it is about"
					onChange={(event) => setTitle(event.target.value)}
				/>
			</div>
			<div className="form-field">
				<label htmlFor="synapse-flag-problem">What is missing or wrong</label>
				<textarea
					id="synapse-flag-problem"
					required
					maxLength={2000}
					rows={3}
					value={problem}
					disabled={busy}
					onChange={(event) => setProblem(event.target.value)}
				/>
			</div>
			<div className="form-field">
				<label htmlFor="synapse-flag-suggestion">
					What it should say (optional)
				</label>
				<textarea
					id="synapse-flag-suggestion"
					maxLength={5000}
					rows={3}
					value={suggestion}
					disabled={busy}
					onChange={(event) => setSuggestion(event.target.value)}
				/>
			</div>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			<div className="form-actions">
				<button
					className="button"
					type="button"
					disabled={busy}
					onClick={onClose}
				>
					Cancel
				</button>
				<button
					className="button primary"
					type="submit"
					disabled={busy || !problem.trim()}
				>
					{busy ? "Filing…" : "File flag"}
				</button>
			</div>
		</form>
	);
}

function FlagCard({
	flag,
	onSettled,
}: {
	flag: SynapseFlag;
	onSettled(message: string): void;
}) {
	const [settling, setSettling] = useState<"resolved" | "dismissed" | null>(
		null,
	);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const settle = async () => {
		if (busy || !settling) return;
		setBusy(true);
		setError("");
		try {
			await resolveSynapseFlag(flag.id, {
				status: settling,
				reason: reason.trim(),
			});
			onSettled(settling === "resolved" ? "Flag resolved." : "Flag dismissed.");
		} catch (cause) {
			setError(failureMessage(cause, "Could not settle the flag."));
		} finally {
			setBusy(false);
		}
	};
	const headingId = `flag-${flag.id}`;
	const waiting = flag.status === "open" || flag.status === "proposed";
	const about = flag.title ?? "the shared space";
	return (
		<article className="card synapse-proposal" aria-labelledby={headingId}>
			<div className="section-heading">
				<div>
					<h2 id={headingId}>
						{KIND_LABEL[flag.kind]}
						{flag.title && (
							<>
								{": "}
								<a className="wikilink" href={noteHash("shared", flag.title)}>
									{flag.title}
								</a>
							</>
						)}
					</h2>
					<p className="card-note">
						Flagged by {flag.author.name} on {shortDate(flag.createdAt)}
						{flag.task && ` · while working on: ${flag.task}`}
					</p>
				</div>
				<span className={`synapse-chip synapse-state-${flag.status}`}>
					{STATUS_LABEL[flag.status]}
				</span>
			</div>
			<p className="synapse-proposal-reason">{flag.problem}</p>
			{flag.suggestion && (
				<div className="synapse-diff synapse-flag-suggestion">
					<div>
						<h3>Suggested</h3>
						<pre>{flag.suggestion}</pre>
					</div>
				</div>
			)}
			{flag.status === "proposed" && (
				<p className="card-note">
					A proposal answers this flag.{" "}
					<a
						className="wikilink"
						href={synapseHash({
							tab: "proposals",
							space: "shared",
							title: null,
						})}
					>
						Review it in Proposals
					</a>
					: approving it resolves the flag, rejecting it opens the flag again.
				</p>
			)}
			{flag.resolution && (
				<p className="synapse-proposal-reason">
					<strong>
						{STATUS_LABEL[flag.status]}
						{flag.resolvedBy && ` by ${flag.resolvedBy.name}`}
						{flag.resolvedAt && ` on ${shortDate(flag.resolvedAt)}`}:
					</strong>{" "}
					{flag.resolution}
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{waiting &&
				(settling ? (
					<form
						className="synapse-inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							void settle();
						}}
					>
						<div className="form-field">
							<label htmlFor={`${headingId}-reason`}>
								{settling === "resolved"
									? "What was done about it"
									: "Why nothing is to be done"}
							</label>
							<textarea
								id={`${headingId}-reason`}
								required
								maxLength={2000}
								rows={2}
								value={reason}
								disabled={busy}
								onChange={(event) => setReason(event.target.value)}
							/>
						</div>
						<div className="form-actions">
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => setSettling(null)}
							>
								Cancel
							</button>
							<button
								className="button primary"
								type="submit"
								disabled={busy || !reason.trim()}
							>
								{busy
									? "Saving…"
									: settling === "resolved"
										? "Confirm resolved"
										: "Confirm dismissal"}
							</button>
						</div>
					</form>
				) : (
					<div className="form-actions">
						<button
							className="button"
							type="button"
							aria-label={`Dismiss the flag about ${about}`}
							onClick={() => setSettling("dismissed")}
						>
							Dismiss
						</button>
						<button
							className="button"
							type="button"
							aria-label={`Mark the flag about ${about} resolved`}
							onClick={() => setSettling("resolved")}
						>
							Mark resolved
						</button>
					</div>
				))}
		</article>
	);
}

/**
 * The workspace's flags: reports that the shared space is missing something
 * or has it wrong, filed by agents while they work and by people here. A
 * curator answers them with proposals; this tab is where a person watches
 * the queue, files one, or settles one by hand.
 */
export function SynapseFlags({ version }: { version: number }) {
	const [status, setStatus] = useState<SynapseFlagStatus | "">("open");
	const [flags, setFlags] = useState<SynapseFlag[] | null>(null);
	/** The last page came back full, so there may be older flags. */
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [creating, setCreating] = useState(false);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseFlags({
				status: status || undefined,
				limit: FLAG_PAGE,
			});
			if (request === sequence.current) {
				setFlags(result.flags);
				setMore(result.flags.length === FLAG_PAGE);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(failureMessage(cause, "Could not load the flags."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [status]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after a proposal's decision settled flags
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh, version]);
	const showOlder = async () => {
		const last = flags?.at(-1);
		if (loading || !flags || !last) return;
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseFlags({
				status: status || undefined,
				limit: FLAG_PAGE,
				// From the last flag shown, not a count: flags filed or settled
				// meanwhile do not shift where the older ones begin.
				before: last.id,
			});
			if (request === sequence.current) {
				setFlags([...flags, ...result.flags]);
				setMore(result.flags.length === FLAG_PAGE);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(failureMessage(cause, "Could not load older flags."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	};
	const written = (message: string) => {
		setNotice(message);
		void refresh();
	};
	return (
		<div className="synapse-flags">
			<div className="section-heading">
				<p className="page-description">
					Agents flag what the shared space is missing or has wrong while they
					work, instead of rewriting it mid-task. An agent with the Synapse
					Curate grant turns flags into proposals; a flag is resolved when its
					proposal is approved.
				</p>
				<button
					className="button primary"
					type="button"
					disabled={creating}
					onClick={() => {
						setNotice("");
						setCreating(true);
					}}
				>
					<Icon name="plus" />
					New flag
				</button>
			</div>
			{creating && (
				<NewFlagForm
					onClose={() => setCreating(false)}
					onFiled={() => {
						setCreating(false);
						written("Flag filed.");
					}}
				/>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			<div className="form-field synapse-commitment-filter">
				<label htmlFor="synapse-flag-status">Status</label>
				<Dropdown
					id="synapse-flag-status"
					value={status}
					onValueChange={(value) => setStatus(value as SynapseFlagStatus | "")}
				>
					<option value="">All statuses</option>
					{SYNAPSE_FLAG_STATUSES.map((item) => (
						<option key={item} value={item}>
							{STATUS_LABEL[item]}
						</option>
					))}
				</Dropdown>
			</div>
			{flags?.length ? (
				<div aria-busy={loading}>
					{flags.map((flag) => (
						<FlagCard key={flag.id} flag={flag} onSettled={written} />
					))}
					{more && (
						<div className="form-actions">
							<button
								className="button"
								type="button"
								disabled={loading}
								onClick={() => void showOlder()}
							>
								{loading ? "Loading…" : "Show older flags"}
							</button>
						</div>
					)}
				</div>
			) : loading && !flags ? (
				<LoadingBanner>Loading flags…</LoadingBanner>
			) : flags ? (
				<div className="empty-state">
					{status
						? `No ${STATUS_LABEL[status].toLowerCase()} flags.`
						: "No flags yet. Agents file them with synapse_flag when the shared space is missing something or has it wrong."}
				</div>
			) : null}
		</div>
	);
}
