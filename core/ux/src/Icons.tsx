export function Icon({
	name,
}: {
	name:
		| "dashboard"
		| "models"
		| "routing"
		| "api-tokens"
		| "agent-tokens"
		| "lock"
		| "collapse"
		| "expand"
		| "plus"
		| "search"
		| "close";
}) {
	const paths = {
		dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
		models: "m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
		routing: "M4 12h6 M10 12V5h10 M10 12v7h10 M17 2l3 3-3 3 M17 16l3 3-3 3",
		"api-tokens": "M14 7a5 5 0 1 1-3 9L4 23H1v-3l7-7a5 5 0 0 1 6-6z M16 10h.01",
		"agent-tokens":
			"M12 3v3 M5 6h14v14H5z M2 10v6 M22 10v6 M9 11h.01 M15 11h.01 M9 16h6",
		lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3",
		collapse: "M9 4H4v16h5 M15 7l-5 5 5 5 M10 12h11",
		expand: "M9 4H4v16h5 M16 7l5 5-5 5 M10 12h11",
		plus: "M12 5v14 M5 12h14",
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
