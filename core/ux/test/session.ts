import { setSessionToken } from "../src/api.js";

export const PASSWORD = "correct horse battery";

/**
 * Completes first-run setup against a real API and, unless `signIn` is false,
 * signs the dashboard in as that owner. Returns the owner's session token.
 */
export async function setUpOwner(
	url: string,
	{
		ownerToken,
		signIn = true,
		email = "founder@example.com",
		name = "Founder",
	}: {
		ownerToken?: string;
		signIn?: boolean;
		email?: string;
		name?: string;
	} = {},
): Promise<string> {
	const response = await fetch(`${url}/v1/setup`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
		},
		body: JSON.stringify({ email, name, password: PASSWORD }),
	});
	if (response.status !== 201)
		throw new Error(`Setup failed: ${await response.text()}`);
	const { token } = (await response.json()) as { token: string };
	if (signIn) setSessionToken(token);
	return token;
}
