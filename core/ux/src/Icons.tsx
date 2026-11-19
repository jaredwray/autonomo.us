export function Icon({
	name,
}: {
	name:
		| "dashboard"
		| "models"
		| "proxies"
		| "synapse"
		| "channels"
		| "organization"
		| "loops"
		| "agents"
		| "api-tokens"
		| "team"
		| "workspaces"
		| "chevron"
		| "logout"
		| "collapse"
		| "expand"
		| "plus"
		| "minus"
		| "fit"
		| "fullscreen"
		| "exit-fullscreen"
		| "search"
		| "close"
		| "check";
}) {
	const paths = {
		check: "m5 12 4 4 10-10",
		dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
		models: "m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
		proxies:
			"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9 M12 3C9.5 5.5 8.2 8.5 8.2 12s1.3 6.5 3.8 9",
		synapse:
			"M12 5v15 M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 7.5a3 3 0 0 0 .6 4.5A3 3 0 0 0 5 17a3 3 0 0 0 4 2.6A3 3 0 0 0 12 20 M12 5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 7.5a3 3 0 0 1-.6 4.5A3 3 0 0 1 19 17a3 3 0 0 1-4 2.6A3 3 0 0 1 12 20 M7 9.5h5 M12 13.5h5",
		organization:
			"M9 2h6v5H9z M2 16h6v5H2z M16 16h6v5h-6z M12 7v5H5v4 M12 12h7v4",
		loops:
			"M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5 M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5",
		channels: "M4 5h16v11H10l-5 4v-4H4z M8 9h8 M8 12h5",
		agents:
			"M12 3v3 M5 6h14v14H5z M2 10v6 M22 10v6 M9 11h.01 M15 11h.01 M9 16h6",
		"api-tokens": "M14 7a5 5 0 1 1-3 9L4 23H1v-3l7-7a5 5 0 0 1 6-6z M16 10h.01",
		team: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 12 0v1 M16 3.5a4 4 0 0 1 0 7.5 M18 14.5a6 6 0 0 1 4 5.5v1",
		workspaces: "M3 7l9-4 9 4-9 4-9-4z M3 7v10l9 4 9-4V7 M12 11v10",
		chevron: "M8 9l4-4 4 4 M8 15l4 4 4-4",
		logout:
			"M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4 M10 17l-5-5 5-5 M5 12h11",
		collapse: "M9 4H4v16h5 M15 7l-5 5 5 5 M10 12h11",
		expand: "M9 4H4v16h5 M16 7l5 5-5 5 M10 12h11",
		plus: "M12 5v14 M5 12h14",
		minus: "M5 12h14",
		fit: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
		fullscreen: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
		"exit-fullscreen": "M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5",
		search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
		close: "m6 6 12 12 M6 18 18 6",
	};
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={paths[name]} />
		</svg>
	);
}
