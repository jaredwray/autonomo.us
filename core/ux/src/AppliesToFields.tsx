import { AGENT_KINDS, type AgentSummary } from "@autonomo.us/common";
import { type Ref, useState } from "react";
import { Icon } from "./Icons.js";

/**
 * Who a budget or a video limit applies to: everyone in the workspace, or
 * agents picked from a searchable list. Agents it names that have since been
 * removed stay listed, so they can be taken out.
 */
export function AppliesToFields({
	id,
	who,
	onWho,
	agentIds,
	onAgentIds,
	agents,
	maxAgents,
	everyoneHint,
	agentsHint,
	firstRef,
}: {
	/** A unique prefix for the radio group's name. */
	id: string;
	who: "everyone" | "agents";
	onWho(who: "everyone" | "agents"): void;
	agentIds: string[];
	onAgentIds(update: (current: string[]) => string[]): void;
	agents: AgentSummary[];
	maxAgents: number;
	/** What "Everyone in this workspace" means here. */
	everyoneHint: string;
	/** What picking several agents means here. */
	agentsHint: string;
	/** Focused when the form opens. */
	firstRef?: Ref<HTMLInputElement>;
}) {
	const [search, setSearch] = useState("");
	const removed = agentIds.filter(
		(agentId) => !agents.some((agent) => agent.id === agentId),
	);
	const shown = agents.filter((agent) =>
		`${agent.name} ${AGENT_KINDS[agent.kind]}`
			.toLowerCase()
			.includes(search.trim().toLowerCase()),
	);
	const toggle = (agentId: string, on: boolean) =>
		onAgentIds((current) =>
			on ? [...current, agentId] : current.filter((item) => item !== agentId),
		);
	const none = agents.length === 0 && removed.length === 0;
	return (
		<>
			<fieldset className="budget-choices">
				<legend>Applies to</legend>
				<label className="budget-choice">
					<input
						ref={firstRef}
						type="radio"
						name={`${id}-who`}
						checked={who === "everyone"}
						onChange={() => onWho("everyone")}
					/>
					<span>
						Everyone in this workspace
						<span className="field-hint">{everyoneHint}</span>
					</span>
				</label>
				<label className="budget-choice">
					<input
						type="radio"
						name={`${id}-who`}
						checked={who === "agents"}
						disabled={none}
						onChange={() => onWho("agents")}
					/>
					<span>
						Specific agents
						<span className="field-hint">
							{none ? "This workspace has no agents yet." : agentsHint}
						</span>
					</span>
				</label>
			</fieldset>
			{who === "agents" && (
				<div className="budget-agents">
					{agents.length > 6 && (
						<label className="model-search">
							<Icon name="search" />
							<input
								type="search"
								aria-label="Search agents"
								placeholder="Search agents…"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</label>
					)}
					<ul aria-label="Agents" className="budget-agent-list">
						{shown.map((agent) => (
							<li key={agent.id}>
								<label>
									<input
										type="checkbox"
										checked={agentIds.includes(agent.id)}
										onChange={(event) => toggle(agent.id, event.target.checked)}
									/>
									<span>
										{agent.name}
										<span className="field-hint">
											{AGENT_KINDS[agent.kind]}
											{agent.status !== "active" ? ` · ${agent.status}` : ""}
										</span>
									</span>
								</label>
							</li>
						))}
						{removed.map((agentId) => (
							<li key={agentId}>
								<label>
									<input
										type="checkbox"
										checked
										onChange={() => toggle(agentId, false)}
									/>
									<span>
										Removed agent
										<span className="field-hint">
											No longer in this workspace. Uncheck to take it out.
										</span>
									</span>
								</label>
							</li>
						))}
						{shown.length === 0 && removed.length === 0 && (
							<li className="field-hint">No agents match.</li>
						)}
					</ul>
					<span className="field-hint">
						{agentIds.length === 0
							? "None picked."
							: `${agentIds.length} picked, at most ${maxAgents}.`}
					</span>
				</div>
			)}
		</>
	);
}
