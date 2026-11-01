import { useEffect, useState } from "react";
import { AgentTokensView } from "./AgentTokensView.js";
import { ApiTokensView } from "./ApiTokensView.js";
import { clearOwnerCredential, hasOwnerCredential } from "./api.js";
import { Dashboard } from "./Dashboard.js";
import { Icon } from "./Icons.js";
import { ModelsView } from "./ModelsView.js";
import { OwnerAccess } from "./OwnerAccess.js";
import { RoutingView } from "./RoutingView.js";

const logoMark = new URL("./assets/logo-mark.svg", import.meta.url).href;

const viewLabels = {
	dashboard: "Dashboard",
	models: "Models",
	routing: "Routing",
	"api-tokens": "API Tokens",
	"agent-tokens": "Agent Tokens",
};
function currentView(): keyof typeof viewLabels {
	const view = window.location.hash.slice(2);
	return Object.hasOwn(viewLabels, view)
		? (view as keyof typeof viewLabels)
		: "dashboard";
}

export function App() {
	const [needsAuth, setNeedsAuth] = useState(false);
	const [authenticated, setAuthenticated] = useState(hasOwnerCredential);
	useEffect(() => {
		const requireAuth = () => {
			clearOwnerCredential();
			setAuthenticated(false);
			setNeedsAuth(true);
		};
		window.addEventListener("autonomous:authentication-required", requireAuth);
		return () =>
			window.removeEventListener(
				"autonomous:authentication-required",
				requireAuth,
			);
	}, []);
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
		const navigate = () => setView(currentView());
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	const toggle = () => {
		const next = !collapsed;
		setCollapsed(next);
		try {
			window.localStorage.setItem("autonomous.sidebar.collapsed", String(next));
		} catch {}
	};
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
					{(
						[
							"dashboard",
							"models",
							"routing",
							"api-tokens",
							"agent-tokens",
						] as const
					).map((item) => (
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
				{authenticated && (
					<button
						className="button sidebar-lock"
						type="button"
						aria-label="Lock dashboard"
						title={collapsed ? "Lock dashboard" : undefined}
						onClick={() => {
							clearOwnerCredential();
							setAuthenticated(false);
							setNeedsAuth(true);
						}}
					>
						<Icon name="lock" />
						<span className="sidebar-label">Lock dashboard</span>
					</button>
				)}
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
				{needsAuth ? (
					<OwnerAccess
						onConnected={() => {
							setAuthenticated(true);
							setNeedsAuth(false);
						}}
					/>
				) : view === "api-tokens" ? (
					<ApiTokensView />
				) : view === "agent-tokens" ? (
					<AgentTokensView />
				) : view === "models" ? (
					<ModelsView />
				) : view === "routing" ? (
					<RoutingView />
				) : (
					<Dashboard />
				)}
			</main>
		</div>
	);
}
