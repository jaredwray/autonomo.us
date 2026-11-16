import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { setCurrentWorkspace } from "../src/api.js";
import { Dashboard } from "../src/Dashboard.js";
import { LoadingBanner } from "../src/LoadingBanner.js";
import { ModelsView } from "../src/ModelsView.js";
import { SynapseProposals } from "../src/SynapseProposals.js";
import "../src/styles.css";

// Real product views; Playwright supplies all responses. No login or backend.
setCurrentWorkspace("synthetic-workspace");
const view = new URLSearchParams(location.search).get("view");
const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		view === "proposals" ? (
			<main className="dashboard">
				<h1>Proposals</h1>
				<SynapseProposals canDecide version={0} onDecided={() => {}} />
			</main>
		) : view === "app" ? (
			<App />
		) : view === "dashboard" ? (
			<main>
				<Dashboard />
			</main>
		) : view === "compact" ? (
			<main style={{ padding: 16, maxWidth: 260 }}>
				<LoadingBanner compact>
					Loading archived channels with a deliberately long synthetic name…
				</LoadingBanner>
			</main>
		) : (
			<main>
				<ModelsView />
			</main>
		),
	);
