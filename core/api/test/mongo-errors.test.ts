import { describe, expect, it } from "vitest";
import { mongoErrorDetails } from "../src/mongo.js";

describe("persistence error logging", () => {
	it("keeps the driver code through wrappers without logging credentials", () => {
		const driver = Object.assign(
			new Error("mongodb://user:secret@host/database"),
			{
				name: "MongoServerError",
				code: 13,
			},
		);
		const error = new Error("Settings unavailable", { cause: driver });
		expect(mongoErrorDetails(error)).toEqual({
			errorType: "MongoServerError",
			code: 13,
		});
	});

	it("rejects arbitrary strings in diagnostic fields", () => {
		const error = Object.assign(new Error("sensitive message"), {
			name: "mongodb://user:secret@host",
			code: "secret value",
		});
		expect(mongoErrorDetails(error)).toEqual({ errorType: "Error" });
		expect(mongoErrorDetails("sensitive message")).toEqual({
			errorType: "UnknownError",
		});
	});
});
