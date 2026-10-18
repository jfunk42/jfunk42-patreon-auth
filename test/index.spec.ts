import {
	createExecutionContext,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Patreon authentication worker", () => {
	it("reports readiness without exposing configuration", async () => {
		const request = new IncomingRequest("https://api.jfunk42.com/health", {
			headers: { Origin: "https://jfunk42.com" },
		});
		const context = createExecutionContext();
		const response = await worker.fetch(request, env, context);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://jfunk42.com");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("does not claim a session for a visitor without the HTTP-only session cookie", async () => {
		const response = await SELF.fetch("https://api.jfunk42.com/api/session", {
			headers: { Origin: "https://jfunk42.com" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ authenticated: false });
	});

	it("reserves temporary feature testing for an authenticated Pi session", async () => {
		const response = await SELF.fetch("https://api.jfunk42.com/api/feature-votes", {
			body: JSON.stringify({
				direction: "up",
				featureId: "math-master-path",
			}),
			headers: {
				"Content-Type": "application/json",
				Origin: "https://jfunk42.com",
			},
			method: "POST",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Log in with Patreon to use Pi testing." });
	});

	it("rejects non-API routes", async () => {
		const response = await SELF.fetch("https://api.jfunk42.com/unrecognized");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found." });
	});
});
