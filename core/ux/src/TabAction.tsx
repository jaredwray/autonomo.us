import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * Where a tabbed page puts the selected tab's main action: at the right of
 * its tab bar. Undefined when no page provides one, so a panel shown on its
 * own keeps its action in place; null until the page's slot has rendered.
 */
export const TabActionSlot = createContext<HTMLElement | null | undefined>(
	undefined,
);

/**
 * A tab's main action, such as Add model. On a page with a slot it shows
 * there while its tab is the one showing, so the bar holds one action at a
 * time; elsewhere it shows where it is written.
 */
export function TabAction({
	active,
	children,
}: {
	/** Whether this action's tab is the one showing. */
	active: boolean;
	children: ReactNode;
}) {
	const slot = useContext(TabActionSlot);
	if (slot === undefined) return <>{children}</>;
	if (!slot || !active) return null;
	return createPortal(children, slot);
}
