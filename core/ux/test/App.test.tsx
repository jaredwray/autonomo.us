import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("App", () => {
	afterEach(() => {
		cleanup();
	});

	it("should render the heading", () => {
		render(<App />);
		expect(screen.getByText("autonomo.us")).toBeDefined();
	});

	it("should render the dashboard description", () => {
		render(<App />);
		expect(screen.getByText("AI Platform Dashboard")).toBeDefined();
	});
});
