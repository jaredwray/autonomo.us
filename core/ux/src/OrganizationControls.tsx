import type {
	DecisionRoute,
	OrgActorRef,
	OrgBranch,
	OrgIdentity,
	OrgPositionDetail,
	RoutePosition,
} from "@autonomo.us/common";
import { useId, useRef, useState } from "react";
import { Icon } from "./Icons.js";
import {
	messageFrom,
	orgLink,
	queryPath,
	useDebouncedQuery,
	useOrgRead,
} from "./organization-state.js";

export function useOrgAction() {
	const locked = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function run(action: () => Promise<void>) {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (cause) {
			setError(messageFrom(cause));
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}
	return { busy, error, run };
}

export function occupantType(identity: OrgIdentity) {
	switch (identity.type) {
		case "human":
			return "Person";
		case "instructions":
			return "Hosted agent";
		case "token":
			return "Token agent";
		case "oauth":
			return "OAuth agent";
	}
}
export function PositionAvatar({ position }: { position: RoutePosition }) {
	const human = position.occupant?.kind === "user";
	return (
		<span aria-hidden="true" className={`org-avatar ${human ? "human" : ""}`}>
			{human ? (
				position.occupant?.name
					.split(/\s+/u)
					.map((word) => word[0])
					.slice(0, 2)
					.join("")
			) : (
				<Icon name={position.occupant ? "agents" : "organization"} />
			)}
		</span>
	);
}

type Choice = { id: string; name: string };
function ChoiceList({
	label,
	value,
	choices,
	loading,
	error,
	search,
	setSearch,
	choose,
	close,
	clear,
}: {
	label: string;
	value: string;
	choices: Choice[];
	loading: boolean;
	error?: string;
	search: string;
	setSearch: (search: string) => void;
	choose: (id: string) => void;
	close: () => void;
	clear?: () => void;
}) {
	const id = useId();
	return (
		<div className="org-picker-results">
			<label htmlFor={id}>Search {label.toLowerCase()}</label>
			<input
				id={id}
				type="search"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			{error && <p role="alert">{error}</p>}
			{loading && <p role="status">Searching…</p>}
			{!loading && !error && !choices.length && <p>No matches.</p>}
			<ul aria-label={label}>
				{choices.map((option) => (
					<li key={option.id}>
						<button
							type="button"
							className="button"
							aria-pressed={value === option.id}
							onClick={() => choose(option.id)}
						>
							{option.name}
						</button>
					</li>
				))}
			</ul>
			<div className="org-actions">
				{clear && (
					<button type="button" className="button" onClick={clear}>
						Clear selection
					</button>
				)}
				<button type="button" className="button" onClick={close}>
					Close picker
				</button>
			</div>
		</div>
	);
}

export function PositionPicker({
	workspace,
	label,
	value,
	onChange,
	occupiedOnly = false,
	humanOnly = false,
	ownOnly = false,
	exclude = [],
	optional = false,
}: {
	workspace: string;
	label: string;
	value: string;
	onChange: (id: string) => void;
	occupiedOnly?: boolean;
	humanOnly?: boolean;
	ownOnly?: boolean;
	exclude?: string[];
	optional?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const term = useDebouncedQuery(search);
	const results = useOrgRead<OrgBranch>(
		workspace,
		open && term === search.trim()
			? queryPath("/branch", { q: term, limit: "25" })
			: null,
	);
	const current = useOrgRead<OrgPositionDetail>(
		workspace,
		value ? `/positions/${encodeURIComponent(value)}` : null,
	);
	const excluded = new Set(exclude);
	const choices = (results.data?.positions ?? [])
		.filter(
			(p) =>
				!p.archived &&
				(!occupiedOnly || !!p.occupant) &&
				!excluded.has(p.id) &&
				(!ownOnly || results.data?.viewerPositionIds.includes(p.id)) &&
				(!humanOnly || p.occupant?.kind === "user"),
		)
		.map((p) => ({
			id: p.id,
			name: p.title + (p.occupant ? ` · ${p.occupant.name}` : " · Vacant"),
		}));
	function choose(id: string) {
		onChange(id);
		setOpen(false);
		setSearch("");
	}
	return (
		<div className="org-picker">
			<span>{label}</span>
			<button
				type="button"
				className="button"
				aria-label={label}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{current.data?.position.title ||
					(value ? "Selected position" : "Choose position")}
			</button>
			{open && (
				<ChoiceList
					label={label}
					value={value}
					choices={choices}
					loading={!results.data && !results.error}
					error={results.error}
					search={search}
					setSearch={setSearch}
					choose={choose}
					close={() => setOpen(false)}
					clear={optional ? () => choose("") : undefined}
				/>
			)}
		</div>
	);
}

export function OccupantPicker({
	workspace,
	label = "Occupant",
	loopAct = false,
	value,
	onChange,
}: {
	workspace: string;
	label?: string;
	loopAct?: boolean;
	value: (OrgActorRef & { name?: string }) | null;
	onChange: (identity: OrgIdentity | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const term = useDebouncedQuery(search);
	const results = useOrgRead<{ identities: OrgIdentity[] }>(
		workspace,
		open && term === search.trim()
			? queryPath("/identities", { q: term, loopAct: loopAct ? "true" : null })
			: null,
	);
	const identities = results.data?.identities ?? [];
	const key = (i: OrgActorRef) => `${i.kind}:${i.id}`;
	return (
		<div className="org-picker">
			<span>{label}</span>
			<button
				type="button"
				className="button"
				aria-label={label}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{value?.name ??
					value?.id ??
					(label === "Occupant" ? "Vacant" : "Choose person or agent")}
			</button>
			{open && (
				<ChoiceList
					label="People and agents"
					value={value ? key(value) : ""}
					choices={identities.map((i) => ({
						id: key(i),
						name: `${i.name} · ${occupantType(i)}`,
					}))}
					loading={!results.data && !results.error}
					error={results.error}
					search={search}
					setSearch={setSearch}
					choose={(id) => {
						onChange(identities.find((i) => key(i) === id) ?? null);
						setOpen(false);
					}}
					close={() => setOpen(false)}
					clear={() => {
						onChange(null);
						setOpen(false);
					}}
				/>
			)}
		</div>
	);
}

export function RouteTrace({
	workspace,
	route,
}: {
	workspace: string;
	route: DecisionRoute;
}) {
	return (
		<div className="org-trace">
			<p>
				{route.ruleVersion === null
					? "Default routing"
					: `Rule version ${route.ruleVersion}`}{" "}
				· Response window {route.deadlineMinutes} min
			</p>
			<ol aria-label="Decision route">
				{route.requesterPosition && (
					<li className="org-route-requester">
						<span>Requester</span>
						<a
							href={orgLink(
								workspace,
								"organization",
								"positions",
								route.requesterPosition.id,
							)}
						>
							{route.requesterPosition.title}
						</a>
						<small>{route.requesterPosition.occupant?.name ?? "Vacant"}</small>
					</li>
				)}
				{route.steps.map((step, index) => (
					<li
						key={`${step.position.id}-${step.role}`}
						className={`org-route-${step.role}`}
					>
						<span>
							{step.role === "owner"
								? "Decision owner"
								: `Fallback ${route.steps.slice(0, index + 1).filter((item) => item.role === "fallback").length}`}
						</span>
						<a
							href={orgLink(
								workspace,
								"organization",
								"positions",
								step.position.id,
							)}
						>
							{step.position.title}
						</a>
						<small>
							{step.position.occupant?.name ?? "Vacant"} · {step.reason}
							{step.eligible ? "" : " · Unavailable"}
						</small>
					</li>
				))}
			</ol>
			{!route.steps.length && <p>Human triage required.</p>}
		</div>
	);
}
