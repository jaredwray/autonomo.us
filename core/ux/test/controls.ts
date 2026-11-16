import { fireEvent, screen } from "@testing-library/react";

/** Exercise custom dropdowns through the visible popup; keep native input events. */
export function changeControl(
	element: HTMLElement,
	init: { target: { value?: string; files?: File[] } },
) {
	if (!element.classList.contains("dropdown-trigger"))
		return fireEvent.change(element, init);
	fireEvent.click(element);
	const option = screen
		.getAllByRole("option")
		.find((item) => item.getAttribute("data-value") === init.target.value);
	if (!option) throw new Error(`No dropdown option ${init.target.value}`);
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

export function dropdownOptions(element: HTMLElement) {
	fireEvent.click(element);
	const options = screen.getAllByRole("option");
	fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
	return options;
}
