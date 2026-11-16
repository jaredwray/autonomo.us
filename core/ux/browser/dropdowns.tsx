import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "../src/Dashboard.js";
import { Dropdown } from "../src/Dropdown.js";
import "../src/styles.css";
function Fixture() {
	const [value, setValue] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	return (
		<main style={{ padding: 24 }}>
			<Dashboard />
			<form
				onSubmit={(event) => {
					event.preventDefault();
					setSubmitted(true);
				}}
			>
				<div className="form-field">
					<label htmlFor="fixture">Required choice</label>
					<Dropdown
						id="fixture"
						name="choice"
						required
						value={value}
						onValueChange={setValue}
					>
						<option value="">Choose…</option>
						<option value="alpha">Alpha</option>
						<option value="disabled" disabled>
							Disabled
						</option>
						<option value="beta">Beta</option>
						<option value="long">
							A very long synthetic model name that should wrap in a narrow
							popup without pushing it outside the viewport
						</option>
					</Dropdown>
				</div>
				<button type="submit">Submit fixture</button>
				<output aria-label="Submitted">{String(submitted)}</output>
				<output aria-label="Choice">{value}</output>
				<fieldset disabled>
					<Dropdown
						aria-label="Disabled by fieldset"
						value="x"
						onValueChange={setValue}
					>
						<option value="x">X</option>
					</Dropdown>
				</fieldset>
				<Dropdown
					aria-label="Disabled"
					disabled
					value="x"
					onValueChange={setValue}
				>
					<option value="x">X</option>
				</Dropdown>
			</form>
			<button type="button" onClick={() => setDialogOpen(true)}>
				Open dialog fixture
			</button>
			{dialogOpen && (
				<div
					role="dialog"
					aria-label="Dropdown dialog"
					onKeyDown={(event) => {
						if (event.key === "Escape" && !event.defaultPrevented)
							setDialogOpen(false);
					}}
					style={{
						overflow: "hidden",
						height: 120,
						border: "1px solid",
						padding: 12,
					}}
				>
					<Dropdown
						aria-label="Long list"
						value={value}
						onValueChange={setValue}
					>
						{Array.from({ length: 40 }, (_, i) => (
							<option key={String(i)} value={String(i)}>
								Synthetic option {i}
							</option>
						))}
					</Dropdown>
					<button type="button" onClick={() => setDialogOpen(false)}>
						Close dialog fixture
					</button>
				</div>
			)}
		</main>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
