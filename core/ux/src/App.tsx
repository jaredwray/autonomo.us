import type {
	AuthStatus,
	CurrentSession,
	WorkspaceAccess,
} from "@autonomo.us/common";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { AgentsView } from "./AgentsView.js";
import { ApiTokensView } from "./ApiTokensView.js";
import { AuthorizeView } from "./AuthorizeView.js";
import {
	AuthLayout,
	InviteView,
	SetupView,
	SignInView,
} from "./AuthScreens.js";
import { signInRequestId } from "./agents-route.js";
import {
	clearCredential,
	credentialKind,
	fetchAuthStatus,
	fetchCurrentSession,
	setCurrentWorkspace,
	signOut,
} from "./api.js";
import { ChannelsView } from "./ChannelsView.js";
import { channelAttention, useChannelList } from "./channels-list.js";
import { Dashboard } from "./Dashboard.js";
import { Icon } from "./Icons.js";
import { ModelsView } from "./ModelsView.js";
import { ProfileView } from "./ProfileView.js";
import { RoutingView } from "./RoutingView.js";
import { SynapseView } from "./SynapseView.js";
import { TeamView } from "./TeamView.js";
import { WorkspacesView } from "./WorkspacesView.js";

const logoMark = new URL("./assets/logo-mark.svg", import.meta.url).href;

/** Views of one workspace's data, at `#/w/<workspace id>/<view>`. */
const workspaceViews = {
	dashboard: "Dashboard",
	models: "Models",
	routing: "Routing",
	synapse: "Synapse",
	channels: "Channels",
	agents: "Agents",
	"api-tokens": "API Tokens",
};
/**
 * Where links from before Bots and Agent Tokens became Agents lead now. A
 * bot's link keeps naming its agent; the token list had nothing after it.
 */
const formerViews: Record<string, { view: WorkspaceView; keepRest: boolean }> =
	{
		bots: { view: "agents", keepRest: true },
		"agent-tokens": { view: "agents", keepRest: false },
	};
/** Views of the whole gateway, at `#/<view>`. */
const instanceViews = { workspaces: "Workspaces", team: "Team" };
const viewLabels = { ...workspaceViews, ...instanceViews };
type WorkspaceView = keyof typeof workspaceViews;
type View = keyof typeof viewLabels | "profile";
/**
 * `rest` is a view's own state after its name: Synapse's /<space>/<note>, a
 * channel's /<name>, an agent's /<id>. `renamed` marks an address that still
 * uses a view's former name and is rewritten once the view is shown.
 */
type Route = {
	view: View;
	workspaceId: string | null;
	rest: string;
	renamed?: boolean;
};
const isWorkspaceView = (view: View): view is WorkspaceView =>
	Object.hasOwn(workspaceViews, view);
function currentRoute(): Route {
	const scoped = /^#\/w\/([^/]+)(?:\/([\w-]+)(\/.*)?)?$/.exec(
		window.location.hash,
	);
	if (scoped) {
		const former = formerView(scoped[2] ?? "");
		const view = (former?.view ?? scoped[2] ?? "dashboard") as View;
		const known = isWorkspaceView(view);
		return {
			view: known ? view : "dashboard",
			workspaceId: decodeURIComponent(scoped[1]),
			rest: known && former?.keepRest !== false ? (scoped[3] ?? "") : "",
			renamed: Boolean(former),
		};
	}
	// A pre-workspace link such as #/models or #/synapse/shared/<note> opens
	// in the remembered workspace.
	const [name = "", ...rest] = window.location.hash.slice(2).split("/");
	const former = formerView(name);
	const view = former?.view ?? name;
	const known = view === "profile" || Object.hasOwn(viewLabels, view);
	return {
		view: known ? (view as View) : "dashboard",
		workspaceId: null,
		rest:
			known && rest.length && former?.keepRest !== false
				? `/${rest.join("/")}`
				: "",
		renamed: Boolean(former),
	};
}
function formerView(name: string) {
	return Object.hasOwn(formerViews, name) ? formerViews[name] : undefined;
}
const href = (view: View, workspaceId: string | null, rest = "") =>
	isWorkspaceView(view) && workspaceId
		? `#/w/${encodeURIComponent(workspaceId)}/${view}${rest}`
		: `#/${view}`;
const WORKSPACE_KEY = "autonomous.workspace";
function rememberedWorkspace(): string | null {
	try {
		return window.localStorage.getItem(WORKSPACE_KEY);
	} catch {
		return null;
	}
}
function rememberWorkspace(id: string) {
	try {
		window.localStorage.setItem(WORKSPACE_KEY, id);
	} catch {}
}
/** The workspace to show: the route's, else the remembered one, else the default. */
function chooseWorkspace(
	workspaces: WorkspaceAccess[],
	requested: string | null,
): WorkspaceAccess | null {
	const open = workspaces.filter((workspace) => !workspace.archivedAt);
	const remembered = rememberedWorkspace();
	return (
		open.find((workspace) => workspace.id === requested) ??
		open.find((workspace) => workspace.id === remembered) ??
		open.find((workspace) => workspace.isDefault) ??
		open[0] ??
		null
	);
}
/** Invite secrets stay in the URL fragment, which browsers never send to servers. */
function inviteToken() {
	return /^#\/invite\/([\w-]+)$/.exec(window.location.hash)?.[1] ?? null;
}
/** An app's OAuth sign-in that the gateway sent here to be decided. */
const signInRequest = () => signInRequestId(window.location.hash);

type Gate =
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "setup"; status: AuthStatus }
	| { state: "sign-in"; status: AuthStatus }
	| { state: "ready"; status: AuthStatus; session: CurrentSession };

export function App() {
	const [gate, setGate] = useState<Gate>({ state: "loading" });
	const [invite, setInvite] = useState(inviteToken);
	const [signInId, setSignInId] = useState(signInRequest);
	const sequence = useRef(0);
	const load = useCallback(async () => {
		const request = ++sequence.current;
		const settle = (next: Gate) => {
			if (request === sequence.current) setGate(next);
		};
		let status: AuthStatus;
		try {
			status = await fetchAuthStatus();
		} catch (cause) {
			settle({
				state: "error",
				message:
					cause instanceof TypeError
						? "The gateway API could not be reached."
						: cause instanceof Error
							? cause.message
							: "The gateway API is unavailable.",
			});
			return;
		}
		if (!status.setupComplete) {
			// A session from a previous database cannot belong to this setup.
			if (credentialKind() === "session") clearCredential();
			settle({ state: "setup", status });
			return;
		}
		// The setup token has no use once setup is complete.
		if (credentialKind() === "setup") clearCredential();
		if (!credentialKind()) {
			settle({ state: "sign-in", status });
			return;
		}
		try {
			settle({ state: "ready", status, session: await fetchCurrentSession() });
		} catch {
			// A rejected credential was cleared by the 401 handler.
			settle(
				credentialKind()
					? {
							state: "error",
							message: "Your session could not be checked. Please retry.",
						}
					: { state: "sign-in", status },
			);
		}
	}, []);
	useEffect(() => {
		void load();
		const requireAuth = () => void load();
		window.addEventListener("autonomous:authentication-required", requireAuth);
		return () => {
			sequence.current++;
			window.removeEventListener(
				"autonomous:authentication-required",
				requireAuth,
			);
		};
	}, [load]);
	const [accountOpen, setAccountOpen] = useState(false);
	const accountRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const dismiss = (event: PointerEvent) => {
			if (!accountRef.current?.contains(event.target as Node))
				setAccountOpen(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setAccountOpen(false);
				if (accountRef.current?.contains(document.activeElement))
					accountRef.current.querySelector("button")?.focus();
			}
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", handleEscape);
		};
	}, []);
	const [route, setRoute] = useState(currentRoute);
	/** Counts landings in another workspace than a link named; see below. */
	const [landed, setLanded] = useState(0);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const switcherRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const dismiss = (event: PointerEvent) => {
			if (!switcherRef.current?.contains(event.target as Node))
				setSwitcherOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSwitcherOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, []);
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const saved = window.localStorage.getItem("autonomous.sidebar.collapsed");
			return saved === null ? window.innerWidth < 760 : saved === "true";
		} catch {
			return window.innerWidth < 760;
		}
	});
	useEffect(() => {
		const navigate = () => {
			setRoute(currentRoute());
			setInvite(inviteToken());
			setSignInId(signInRequest());
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	const go = (next: View, workspaceId: string | null = route.workspaceId) => {
		window.history.replaceState(null, "", href(next, workspaceId));
		setRoute({ view: next, workspaceId, rest: "" });
		setInvite(null);
		setSignInId(null);
	};
	/** Re-reads the session after a workspace is created, renamed, or archived. */
	const refreshSession = useCallback(async () => {
		try {
			const session = await fetchCurrentSession();
			setGate((current) =>
				current.state === "ready" ? { ...current, session } : current,
			);
		} catch {}
	}, []);
	const workspaces = gate.state === "ready" ? gate.session.workspaces : [];
	const selected = chooseWorkspace(workspaces, route.workspaceId);
	// Workspace calls go to the selected workspace's paths. This is set during
	// render, not in an effect, so the views below (remounted per workspace by
	// their key) already call the right paths in their first effects. The
	// remembered workspace is per browser, so two tabs share the last choice
	// while each keeps the workspace in its own URL.
	setCurrentWorkspace(selected?.id ?? null);
	const wrongWorkspace = Boolean(
		route.workspaceId && selected && route.workspaceId !== selected.id,
	);
	// Read here, not in the Channels view, so the sidebar shows unread channels
	// and mentions from every view.
	const channelList = useChannelList(
		gate.state === "ready" && !invite && !signInId
			? (selected?.id ?? null)
			: null,
	);
	const attention = channelAttention(channelList.channels);
	// A layout effect, so the address is right by the time the view is seen.
	useLayoutEffect(() => {
		if (gate.state !== "ready" || !selected || signInId) return;
		rememberWorkspace(selected.id);
		// Canonical URL: a workspace view always names its workspace, by the
		// name the view has now.
		if (
			isWorkspaceView(route.view) &&
			(route.workspaceId !== selected.id || route.renamed)
		) {
			// A link into a workspace that cannot be opened lands in this one.
			// What followed the view (a note, a channel, an agent) named something
			// there, so it is dropped. A link from before workspaces keeps it.
			const rest =
				route.workspaceId === null || route.workspaceId === selected.id
					? route.rest
					: "";
			window.history.replaceState(
				null,
				"",
				href(route.view, selected.id, rest),
			);
			// The view on screen was mounted from the old address. Mount it
			// again, so it reads the one it has now. The route keeps the
			// workspace the link named, so the notice that it is not
			// available stays until the person goes somewhere.
			if (rest !== route.rest) {
				setRoute({ ...route, rest, renamed: false });
				setLanded((count) => count + 1);
			}
			// Rewritten once: afterwards the view keeps its own address.
			else if (route.renamed) setRoute({ ...route, renamed: false });
		}
	}, [gate.state, selected, route, signInId]);
	const toggle = () => {
		const next = !collapsed;
		setCollapsed(next);
		try {
			window.localStorage.setItem("autonomous.sidebar.collapsed", String(next));
		} catch {}
	};

	if (gate.state === "loading")
		return (
			<main className="auth-shell" aria-busy="true">
				<p role="status">Loading…</p>
			</main>
		);
	if (gate.state === "error")
		return (
			<AuthLayout labelledBy="gateway-error-heading">
				<h1 id="gateway-error-heading">Can't reach the gateway</h1>
				<p className="banner-error" role="alert">
					{gate.message}
				</p>
				<button className="button primary" type="button" onClick={load}>
					Retry
				</button>
			</AuthLayout>
		);
	if (gate.state === "setup")
		return (
			<SetupView
				status={gate.status}
				onComplete={(session) => {
					go("team", null);
					setGate({
						state: "ready",
						status: { ...gate.status, setupComplete: true },
						session: {
							user: session.user,
							expiresAt: session.expiresAt,
							workspaces: [],
						},
					});
					void refreshSession();
				}}
			/>
		);
	if (invite)
		return (
			<InviteView
				key={invite}
				token={invite}
				status={gate.status}
				onJoined={() => {
					go("dashboard");
					void load();
				}}
				onCancel={() => {
					go("dashboard");
					void load();
				}}
			/>
		);
	if (gate.state === "sign-in")
		return <SignInView status={gate.status} onSignedIn={() => void load()} />;
	// After the sign-in gate, so someone signed out signs in and then decides.
	if (signInId)
		return (
			<AuthorizeView
				key={signInId}
				id={signInId}
				workspaces={workspaces}
				onLeave={() => go("dashboard")}
			/>
		);

	const { user } = gate.session;
	// API tokens outlive their creator, so only owners and admins manage them.
	const allowed = (item: View) =>
		user.role !== "member" || item !== "api-tokens";
	const shown = allowed(route.view) ? route.view : "dashboard";
	const openWorkspaces = workspaces.filter(
		(workspace) => !workspace.archivedAt,
	);
	const workspaceId = selected?.id ?? null;
	return (
		<div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
			<button
				className="skip-link"
				type="button"
				onClick={() => {
					document.getElementById("main-content")?.focus();
				}}
			>
				Skip to content
			</button>
			<aside className="sidebar" id="sidebar" aria-label="Sidebar">
				<a
					className="sidebar-brand"
					href={href("dashboard", workspaceId)}
					aria-label="autonomo.us home"
					title={collapsed ? "autonomo.us" : undefined}
				>
					<img src={logoMark} alt="" width="36" height="29" />
					<span className="sidebar-label">autonomo.us</span>
				</a>
				{selected && (
					<div className="workspace-switcher" ref={switcherRef}>
						{openWorkspaces.length > 1 ? (
							<button
								type="button"
								className="workspace-current"
								aria-label={`Workspace: ${selected.name}. Switch workspace`}
								aria-expanded={switcherOpen}
								aria-controls="workspace-menu"
								title={collapsed ? selected.name : undefined}
								onClick={() => setSwitcherOpen(!switcherOpen)}
							>
								<span className="workspace-avatar" aria-hidden="true">
									{selected.name.slice(0, 1).toUpperCase()}
								</span>
								<span className="sidebar-label workspace-name">
									<small>Workspace</small>
									<strong>{selected.name}</strong>
								</span>
								<span className="sidebar-label workspace-chevron">
									<Icon name="chevron" />
								</span>
							</button>
						) : (
							<div
								className="workspace-current single"
								title={collapsed ? selected.name : undefined}
							>
								<span className="workspace-avatar" aria-hidden="true">
									{selected.name.slice(0, 1).toUpperCase()}
								</span>
								<span className="sidebar-label workspace-name">
									<small>Workspace</small>
									<strong>{selected.name}</strong>
								</span>
							</div>
						)}
						{switcherOpen && (
							<div className="workspace-menu" id="workspace-menu">
								<p className="workspace-menu-label">Switch workspace</p>
								{openWorkspaces.map((workspace) => (
									<a
										key={workspace.id}
										href={href(
											isWorkspaceView(shown) ? shown : "dashboard",
											workspace.id,
										)}
										aria-current={
											workspace.id === selected.id ? "true" : undefined
										}
										onClick={() => setSwitcherOpen(false)}
									>
										<span className="workspace-avatar" aria-hidden="true">
											{workspace.name.slice(0, 1).toUpperCase()}
										</span>
										<span>{workspace.name}</span>
										{workspace.id === selected.id && (
											<span className="workspace-check">Current</span>
										)}
									</a>
								))}
								<a
									className="workspace-manage"
									href={`${window.location.pathname}${window.location.search}#/workspaces`}
									onClick={() => setSwitcherOpen(false)}
								>
									Manage workspaces
								</a>
							</div>
						)}
					</div>
				)}
				<nav aria-label="Main navigation">
					{(Object.keys(viewLabels) as (keyof typeof viewLabels)[])
						.filter(allowed)
						.map((item) => (
							<a
								key={item}
								href={href(item, workspaceId)}
								className={`nav-item ${shown === item ? "active" : ""}`}
								aria-current={shown === item ? "page" : undefined}
								aria-label={viewLabels[item]}
								aria-describedby={
									item === "channels" && attention.unread
										? "channels-attention"
										: undefined
								}
								title={collapsed ? viewLabels[item] : undefined}
								onClick={() =>
									setRoute({
										view: item,
										workspaceId: route.workspaceId,
										rest: "",
									})
								}
							>
								<Icon name={item} />
								<span className="sidebar-label">{viewLabels[item]}</span>
								{item === "channels" && attention.unread && (
									<span
										id="channels-attention"
										className={`nav-attention${attention.mentions ? "" : " dot"}`}
									>
										{attention.mentions > 0 &&
											(attention.mentions > 99 ? "99+" : attention.mentions)}
										<span className="visually-hidden">
											{attention.mentions > 0
												? attention.mentions === 1
													? " unread mention"
													: " unread mentions"
												: "Unread messages"}
										</span>
									</span>
								)}
							</a>
						))}
				</nav>
				<div className="sidebar-account" ref={accountRef}>
					<button
						type="button"
						aria-label={`Account menu for ${user.name || user.email}`}
						aria-expanded={accountOpen}
						aria-controls="account-menu"
						onClick={() => setAccountOpen(!accountOpen)}
						className="sidebar-user"
						title={collapsed ? user.email : undefined}
					>
						<span className="sidebar-avatar" aria-hidden="true">
							{(user.name || user.email).slice(0, 1).toUpperCase()}
						</span>
						<span className="sidebar-label sidebar-user-text">
							<strong>{user.name || user.email}</strong>
							<small>{user.email}</small>
						</span>
					</button>
					{accountOpen && (
						<div className="account-menu" id="account-menu">
							<a
								href={`${window.location.pathname}${window.location.search}#/profile`}
								onClick={() => {
									go("profile");
									setAccountOpen(false);
								}}
							>
								Profile settings
							</a>
							<button
								className="account-sign-out"
								type="button"
								aria-label="Sign out"
								title={collapsed ? "Sign out" : undefined}
								onClick={async () => {
									setAccountOpen(false);
									await signOut();
									void load();
								}}
							>
								<Icon name="logout" />
								<span>Sign out</span>
							</button>
						</div>
					)}
				</div>
				<button
					type="button"
					className="sidebar-toggle"
					onClick={toggle}
					aria-expanded={!collapsed}
					aria-controls="sidebar"
					aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
				>
					<Icon name={collapsed ? "expand" : "collapse"} />
				</button>
			</aside>
			<main id="main-content" tabIndex={-1} className="main-content">
				{shown === "profile" ? (
					<ProfileView user={user} />
				) : shown === "team" ? (
					<TeamView workspaces={workspaces} currentWorkspaceId={workspaceId} />
				) : shown === "workspaces" ? (
					<WorkspacesView onChanged={() => void refreshSession()} />
				) : !selected ? (
					<div className="dashboard">
						<header className="dashboard-header">
							<h1>{viewLabels[shown]}</h1>
						</header>
						<div className="card empty-state" role="status">
							You don't have access to a workspace yet. Ask an owner or admin to
							add you to one.
						</div>
					</div>
				) : (
					// Keyed by workspace: switching unmounts the old view, so a
					// response for the previous workspace can never land here.
					<div
						key={`${selected.id}:${landed}`}
						className="workspace-scope-root"
					>
						{wrongWorkspace && (
							<p className="banner-warning workspace-fallback" role="status">
								That workspace isn't available. Showing {selected.name}.
							</p>
						)}
						{shown === "api-tokens" ? (
							<ApiTokensView workspace={selected} />
						) : shown === "models" ? (
							<ModelsView workspace={selected} />
						) : shown === "synapse" ? (
							<SynapseView user={user} workspace={selected} />
						) : shown === "agents" ? (
							<AgentsView
								workspace={selected}
								channels={channelList.channels}
							/>
						) : shown === "channels" ? (
							<ChannelsView
								user={user}
								workspace={selected}
								list={channelList}
							/>
						) : shown === "routing" ? (
							<RoutingView />
						) : (
							<Dashboard />
						)}
					</div>
				)}
			</main>
		</div>
	);
}
