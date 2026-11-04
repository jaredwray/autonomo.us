import type { AuthStatus, CurrentSession } from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentTokensView } from "./AgentTokensView.js";
import { ApiTokensView } from "./ApiTokensView.js";
import {
	AuthLayout,
	InviteView,
	SetupView,
	SignInView,
} from "./AuthScreens.js";
import {
	clearCredential,
	credentialKind,
	fetchAuthStatus,
	fetchCurrentSession,
	signOut,
} from "./api.js";
import { Dashboard } from "./Dashboard.js";
import { Icon } from "./Icons.js";
import { ModelsView } from "./ModelsView.js";
import { RoutingView } from "./RoutingView.js";
import { TeamView } from "./TeamView.js";

const logoMark = new URL("./assets/logo-mark.svg", import.meta.url).href;

const viewLabels = {
	dashboard: "Dashboard",
	models: "Models",
	routing: "Routing",
	"api-tokens": "API Tokens",
	"agent-tokens": "Agent Tokens",
	team: "Team",
};
type View = keyof typeof viewLabels;
function currentView(): View {
	const view = window.location.hash.slice(2);
	return Object.hasOwn(viewLabels, view) ? (view as View) : "dashboard";
}
/** Invite secrets stay in the URL fragment, which browsers never send to servers. */
function inviteToken() {
	return /^#\/invite\/([\w-]+)$/.exec(window.location.hash)?.[1] ?? null;
}

type Gate =
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "setup"; status: AuthStatus }
	| { state: "sign-in"; status: AuthStatus }
	| { state: "ready"; status: AuthStatus; session: CurrentSession };

export function App() {
	const [gate, setGate] = useState<Gate>({ state: "loading" });
	const [invite, setInvite] = useState(inviteToken);
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
	const [view, setView] = useState(currentView);
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
			setView(currentView());
			setInvite(inviteToken());
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	const go = (next: View) => {
		window.history.replaceState(null, "", `#/${next}`);
		setView(next);
		setInvite(null);
	};
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
					go("team");
					setGate({
						state: "ready",
						status: { ...gate.status, setupComplete: true },
						session: { user: session.user, expiresAt: session.expiresAt },
					});
				}}
			/>
		);
	if (invite)
		return (
			<InviteView
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

	const { user } = gate.session;
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
					href="#/dashboard"
					aria-label="autonomo.us home"
					title={collapsed ? "autonomo.us" : undefined}
				>
					<img src={logoMark} alt="" width="36" height="29" />
					<span className="sidebar-label">autonomo.us</span>
				</a>
				<nav aria-label="Main navigation">
					{(Object.keys(viewLabels) as View[]).map((item) => (
						<a
							key={item}
							href={`#/${item}`}
							className={`nav-item ${view === item ? "active" : ""}`}
							aria-current={view === item ? "page" : undefined}
							aria-label={viewLabels[item]}
							title={collapsed ? viewLabels[item] : undefined}
							onClick={() => setView(item)}
						>
							<Icon name={item} />
							<span className="sidebar-label">{viewLabels[item]}</span>
						</a>
					))}
				</nav>
				<div className="sidebar-account">
					<div
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
					</div>
					<button
						className="button sidebar-lock"
						type="button"
						aria-label="Sign out"
						title={collapsed ? "Sign out" : undefined}
						onClick={async () => {
							await signOut();
							void load();
						}}
					>
						<Icon name="logout" />
						<span className="sidebar-label">Sign out</span>
					</button>
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
					<span className="sidebar-label">Collapse sidebar</span>
				</button>
			</aside>
			<main id="main-content" tabIndex={-1} className="main-content">
				{view === "api-tokens" ? (
					<ApiTokensView />
				) : view === "agent-tokens" ? (
					<AgentTokensView />
				) : view === "models" ? (
					<ModelsView />
				) : view === "routing" ? (
					<RoutingView />
				) : view === "team" ? (
					<TeamView />
				) : (
					<Dashboard />
				)}
			</main>
		</div>
	);
}
