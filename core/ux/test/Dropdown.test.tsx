import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { Dropdown } from "../src/Dropdown.js";
import { changeControl } from "./controls.js";

afterEach(cleanup);

function Example() {
	const [value, setValue] = useState("");
	return (
		<>
			<label htmlFor="period">Period</label>
			<Dropdown id="period" value={value} onValueChange={setValue}>
				<option value="">All time</option>
				<option value="day">Last day</option>
				<option value="disabled" disabled>
					Unavailable
				</option>
				<option value="week">Last week</option>
			</Dropdown>
			<output aria-label="Selection">{value || "all"}</output>
			<button type="button">Next</button>
		</>
	);
}

it("supports keyboard selection, refuses disabled options, and restores focus on Escape", async () => {
	const user = userEvent.setup();
	render(<Example />);
	const trigger = screen.getByRole("combobox", { name: "Period" });
	await user.tab();
	expect(document.activeElement).toBe(trigger);
	await user.keyboard("{ArrowDown}");
	await waitFor(() =>
		expect(document.activeElement?.getAttribute("role")).toBe("option"),
	);
	await user.keyboard("{End}{Enter}");
	expect(screen.getByLabelText("Selection").textContent).toBe("week");
	expect(document.activeElement).toBe(trigger);
	await user.keyboard("{ArrowDown}{Home}{ArrowDown}{ArrowDown}");
	expect(document.activeElement).toBe(
		screen.getByRole("option", { name: "Unavailable" }),
	);
	await user.keyboard("{Enter}");
	expect(screen.getByRole("listbox")).toBeDefined();
	expect(screen.getByLabelText("Selection").textContent).toBe("week");
	await user.keyboard("{Home}{Escape}");
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(document.activeElement).toBe(trigger);
	expect(screen.getByLabelText("Selection").textContent).toBe("week");
});

it("selects an empty-string option and preserves the visible label", () => {
	render(<Example />);
	changeControl(screen.getByRole("combobox", { name: "Period" }), {
		target: { value: "day" },
	});
	expect(screen.getByLabelText("Selection").textContent).toBe("day");
	changeControl(screen.getByRole("combobox", { name: "Period" }), {
		target: { value: "" },
	});
	expect(screen.getByLabelText("Selection").textContent).toBe("all");
	expect(screen.getByRole("combobox").textContent).toBe("All time");
});

it("keeps disabled controls out of the tab sequence", async () => {
	const user = userEvent.setup();
	render(
		<>
			<Dropdown
				aria-label="Disabled"
				disabled
				value="x"
				onValueChange={() => {}}
			>
				<option value="x">X</option>
			</Dropdown>
			<button type="button">Next</button>
		</>,
	);
	await user.tab();
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: "Next" }),
	);
	await user.click(screen.getByRole("combobox"));
	expect(screen.queryByRole("listbox")).toBeNull();
});
