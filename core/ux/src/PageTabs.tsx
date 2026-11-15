/**
 * A page's sections as ARIA tabs: arrow keys, Home, and End move between
 * them, and one panel follows the selected tab. Tab ids are
 * `<idPrefix>-tab-<tab>` and the panel's is `<idPrefix>-panel`, so the panel
 * can name the tab that labels it.
 */
export function PageTabs<T extends string>({
	label,
	idPrefix,
	tabs,
	selected,
	onSelect,
}: {
	label: string;
	idPrefix: string;
	tabs: readonly { id: T; label: string }[];
	selected: T;
	onSelect(tab: T): void;
}) {
	return (
		<div
			className="page-tabs"
			role="tablist"
			aria-label={label}
			onKeyDown={(event) => {
				const at = tabs.findIndex((tab) => tab.id === selected);
				const next =
					event.key === "ArrowRight"
						? tabs[(at + 1) % tabs.length]
						: event.key === "ArrowLeft"
							? tabs[(at + tabs.length - 1) % tabs.length]
							: event.key === "Home"
								? tabs[0]
								: event.key === "End"
									? tabs[tabs.length - 1]
									: undefined;
				if (!next) return;
				event.preventDefault();
				onSelect(next.id);
				document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
			}}
		>
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					id={`${idPrefix}-tab-${tab.id}`}
					aria-controls={`${idPrefix}-panel`}
					aria-selected={selected === tab.id}
					tabIndex={selected === tab.id ? 0 : -1}
					onClick={() => onSelect(tab.id)}
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}
