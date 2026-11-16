/** Indeterminate loading: decorative motion never changes the spoken status. */
export function LoadingBanner({
	children,
	compact = false,
}: {
	children: string;
	compact?: boolean;
}) {
	return (
		<span
			className={`loading-banner${compact ? " loading-banner--compact" : ""}`}
			role="status"
			aria-live="polite"
			aria-atomic="true"
		>
			<span className="loading-banner-orbit" aria-hidden="true">
				<span />
			</span>
			<span className="loading-banner-label">{children}</span>
			<span className="loading-banner-track" aria-hidden="true">
				<span />
			</span>
		</span>
	);
}
