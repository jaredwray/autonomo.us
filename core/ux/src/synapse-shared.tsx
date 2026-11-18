import type { ReactNode } from "react";
import { noteHash } from "./synapse-route.js";

/** What a failed request says, or `fallback` when it says nothing. */
export const failureMessage = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** The day of an ISO timestamp, as YYYY-MM-DD. */
export const shortDate = (value: string) => value.slice(0, 10);

/** YYYY-MM-DD HH:MM (UTC) of an ISO timestamp, for "when did this happen". */
export const shortDateTime = (value: string) =>
	`${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;

/** A link to a note that opens it in place, like a [[wikilink]] in a body. */
export function NoteLink({
	space,
	title,
	onNavigate,
	unresolved = false,
	children,
}: {
	space: string;
	title: string;
	onNavigate(title: string): void;
	/** No note has this title yet: the link leads to where it can be created. */
	unresolved?: boolean;
	children?: ReactNode;
}) {
	return (
		<a
			className={`wikilink${unresolved ? " unresolved" : ""}`}
			href={noteHash(space, title)}
			title={unresolved ? `No note titled “${title}” yet` : undefined}
			onClick={(event) => {
				event.preventDefault();
				onNavigate(title);
			}}
		>
			{children ?? title}
		</a>
	);
}
