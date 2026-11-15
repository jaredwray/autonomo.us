import type { AgentTokenSecret, AgentWakePayload } from "@autonomo.us/common";
import { type CreateServerOptions, createServer } from "@autonomo.us/server";
import {
	cleanup,
	configure,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { clearCredential } from "../src/api.js";
import { defaultWorkspaceId, setUpOwner, stopServer } from "./session.js";

// The webhook card runs against a real gateway. Its POSTs go to a recording
// transport instead of the network; each answers with the next queued status.

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

type Transport = NonNullable<
	NonNullable<CreateServerOptions["agentWebhooks"]>["transport"]
>;
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
	window.sessionStorage.clear();
});

async function boot() {
	const received: Array<{
		headers: Record<string, string>;
		body: AgentWakePayload;
	}> = [];
	const answers: number[] = [];
	const transport: Transport = Object.assign(
		async (request: { headers: Record<string, string>; body: string }) => {
			received.push({
				headers: request.headers,
				body: JSON.parse(request.body) as AgentWakePayload,
			});
			return { status: answers.shift() ?? 200, retryAfter: null };
		},
		{ pinsAddress: false as const },
	);
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
		agentWebhooks: { transport },
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const owner = await setUpOwner(url);
	const workspaceId = await defaultWorkspaceId(url, owner);
	const response = await fetch(`${url}/v1/${workspaceId}/agent-tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${owner}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: "Scout",
			description: "",
			ttlDays: 7,
			permissions: ["mcp:read", "mcp:call"],
		}),
	});
	const agent = ((await response.json()) as AgentTokenSecret).token;
	/** Sets up a webhook through the API, as another admin might have. */
	const hook = (body: object) =>
		fetch(`${url}/v1/${workspaceId}/agents/${agent.id}/webhook`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${owner}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	return { received, answers, agent, hook };
}

const type = (element: HTMLElement, value: string) =>
	fireEvent.change(element, { target: { value } });
const facts = (scope: ReturnType<typeof within>, term: string) =>
	(scope.getByText(term, { selector: "dt" }).nextElementSibling as HTMLElement)
		.textContent;

it("adds a webhook for a Claude Code routine, tests, pauses, edits, and deletes it", async () => {
	const { received, answers, agent } = await boot();
	window.history.replaceState(null, "", `#/agents/${agent.id}`);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	await screen.findByRole("region", { name: "Webhook" });
	const card = () => within(screen.getByRole("region", { name: "Webhook" }));
	fireEvent.click(await card().findByRole("button", { name: "Add webhook" }));

	type(card().getByLabelText("URL"), "http://hooks.example.com/x");
	expect(card().getByText("A webhook URL must use https.")).toBeDefined();
	expect(
		(card().getByRole("button", { name: "Add webhook" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	type(
		card().getByLabelText("URL"),
		"https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire",
	);
	expect(card().getByText(/This is a Claude Code routine/)).toBeDefined();
	fireEvent.click(
		card().getByRole("button", { name: "Add anthropic-version" }),
	);
	expect(
		(card().getByLabelText("Header 1 name") as HTMLInputElement).value,
	).toBe("anthropic-version");
	expect(
		card().queryByRole("button", { name: "Add anthropic-version" }),
	).toBeNull();
	type(card().getByLabelText("Auth key"), "sk-ant-oat01-routine");
	for (const name of [
		/^Mentions and replies/,
		/^New messages/,
		/^Proposal decisions/,
	])
		expect(
			(card().getByRole("checkbox", { name }) as HTMLInputElement).checked,
		).toBe(true);
	fireEvent.click(card().getByRole("button", { name: "Add webhook" }));

	const secret = (
		(await card().findByLabelText("Signing secret")) as HTMLTextAreaElement
	).value;
	expect(secret).toMatch(/^whsec_/);
	expect(await screen.findByText("Added a webhook to Scout.")).toBeDefined();
	fireEvent.click(
		card().getByRole("button", { name: "I’ve saved this secret" }),
	);
	expect(card().queryByLabelText("Signing secret")).toBeNull();
	expect(facts(card(), "Status")).toBe("Active");
	expect(facts(card(), "Headers")).toBe("anthropic-version");
	expect(facts(card(), "Auth key")).toBe(
		"Sent as Authorization: Bearer (hidden)",
	);
	expect(facts(card(), "Signing secret")).toBe(`${secret.slice(0, 10)}…`);
	expect(document.body.textContent).not.toContain("sk-ant-oat01-routine");

	fireEvent.click(card().getByRole("button", { name: "Send test" }));
	expect(
		await card().findByText(/^Test delivered: the receiver answered 200/),
	).toBeDefined();
	expect(received[0].headers).toMatchObject({
		authorization: "Bearer sk-ant-oat01-routine",
		"anthropic-version": "2023-06-01",
	});
	expect(received[0].body.data.events[0]).toMatchObject({
		type: "webhook.test",
		requestedBy: "Founder",
	});
	answers.push(401);
	fireEvent.click(card().getByRole("button", { name: "Send test" }));
	expect(
		await card().findByText("Test failed: the receiver answered 401."),
	).toBeDefined();

	fireEvent.click(card().getByRole("button", { name: "Pause" }));
	await waitFor(() =>
		expect(facts(card(), "Status")).toBe("Paused: nothing is sent."),
	);
	fireEvent.click(card().getByRole("button", { name: "Start" }));
	await waitFor(() => expect(facts(card(), "Status")).toBe("Active"));

	fireEvent.click(card().getByRole("button", { name: "Edit webhook" }));
	expect(
		card().getByText("Sends anthropic-version. Values are hidden."),
	).toBeDefined();
	fireEvent.click(card().getByRole("checkbox", { name: /^New messages/ }));
	fireEvent.click(card().getByRole("button", { name: "Save webhook" }));
	await waitFor(() =>
		expect(facts(card(), "Wakes on")).toBe(
			"Mentions and replies, Proposal decisions",
		),
	);
	// The saved headers and key were kept.
	expect(facts(card(), "Headers")).toBe("anthropic-version");
	// Every change shows in the agent's history, without the key.
	const history = within(screen.getByRole("region", { name: "History" }));
	expect(
		await history.findByText(
			"Webhook changed: wakes on mentions and replies, proposal decisions.",
		),
	).toBeDefined();

	fireEvent.click(card().getByRole("button", { name: "Delete webhook" }));
	fireEvent.click(card().getByRole("button", { name: "Delete webhook" }));
	expect(
		await card().findByRole("button", { name: "Add webhook" }),
	).toBeDefined();
	expect(
		await screen.findByText("Deleted the webhook of Scout."),
	).toBeDefined();
});

it("keeps saved headers when a routine webhook is edited", async () => {
	const { agent, hook } = await boot();
	expect(
		(
			await hook({
				url: "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire",
				headers: [{ name: "X-Api-Key", value: "kept" }],
			})
		).status,
	).toBe(201);
	window.history.replaceState(null, "", `#/agents/${agent.id}`);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	await screen.findByRole("region", { name: "Webhook" });
	const card = () => within(screen.getByRole("region", { name: "Webhook" }));
	fireEvent.click(await card().findByRole("button", { name: "Edit webhook" }));
	// Adding the routine's header here would drop X-Api-Key, whose value is hidden.
	expect(
		card().queryByRole("button", { name: "Add anthropic-version" }),
	).toBeNull();
	expect(card().getByText(/To add it, choose/)).toBeDefined();
	fireEvent.click(card().getByRole("button", { name: "Replace headers" }));
	expect(
		card().getByRole("button", { name: "Add anthropic-version" }),
	).toBeDefined();
});
