import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dropdown } from "../src/Dropdown.js";
import { Dashboard } from "../src/Dashboard.js";
import "../src/styles.css";
function Fixture() {
 const [value, setValue] = useState("");
 const [submitted, setSubmitted] = useState(false);
 return <main style={{ padding: 24 }}><Dashboard /><form onSubmit={(event) => {event.preventDefault();setSubmitted(true);}}>
 <div className="form-field"><label htmlFor="fixture">Required choice</label><Dropdown id="fixture" name="choice" required value={value} onValueChange={setValue}>
 <option value="">Choose…</option><option value="alpha">Alpha</option><option value="disabled" disabled>Disabled</option><option value="beta">Beta</option><option value="long">A very long synthetic model name that should wrap in a narrow popup without pushing it outside the viewport</option>
 </Dropdown></div><button type="submit">Submit fixture</button><output aria-label="Submitted">{String(submitted)}</output><output aria-label="Choice">{value}</output>
 <fieldset disabled><Dropdown aria-label="Disabled by fieldset" value="x" onValueChange={setValue}><option value="x">X</option></Dropdown></fieldset>
 <Dropdown aria-label="Disabled" disabled value="x" onValueChange={setValue}><option value="x">X</option></Dropdown>
 </form></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
