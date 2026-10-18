interface Env {
	AUTH_HASH_KEY: string;
	DB: D1Database;
	PATREON_CLIENT_ID: string;
	PATREON_CLIENT_SECRET: string;
	PATREON_TIER_MAP?: string;
	PUBLIC_SITE_ORIGIN: string;
}

interface PatreonResource {
	attributes?: { title?: string };
	id: string;
	relationships?: Record<string, { data?: PatreonResourceReference[] }>;
	type: string;
}

interface PatreonResourceReference {
	id: string;
	type: string;
}

interface PatreonIdentityResponse {
	data: PatreonResource;
	included?: PatreonResource[];
}

interface Session {
	expiresAt: number;
	patreonUserHash: string;
	tier: string | null;
}

const encoder = new TextEncoder();
const piTestIntervalSeconds = 60 * 60;
const stateLifetimeSeconds = 10 * 60;
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const sessionCookieName = "__Host-jfunk42-patreon-session";
const featureIds = new Set([
	"math-performance-tracking",
	"math-master-path",
	"podcast-member-alpha",
]);

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(request: Request, body: unknown, status = 200): Response {
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	addCorsHeaders(request, headers);
	return new Response(JSON.stringify(body), { status, headers });
}

function addCorsHeaders(request: Request, headers: Headers): void {
	const origin = request.headers.get("Origin");
	if (origin === "https://jfunk42.com") {
		headers.set("Access-Control-Allow-Credentials", "true");
		headers.set("Access-Control-Allow-Headers", "Content-Type");
		headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Vary", "Origin");
	}
}

function redirect(url: URL, status = 302): Response {
	return new Response(null, {
		status,
		headers: {
			"Cache-Control": "no-store",
			Location: url.toString(),
		},
	});
}

function nowInSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value: string, key: string): Promise<string> {
	const signingKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(value));
	return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getCookie(request: Request, name: string): string | null {
	const value = request.headers.get("Cookie");
	if (!value) {
		return null;
	}

	for (const pair of value.split(";")) {
		const [key, ...parts] = pair.trim().split("=");
		if (key === name) {
			return parts.join("=") || null;
		}
	}

	return null;
}

function sessionCookie(value: string, expiresAt: number): string {
	return [
		`${sessionCookieName}=${value}`,
		"HttpOnly",
		"Path=/",
		"SameSite=Lax",
		"Secure",
		`Max-Age=${Math.max(expiresAt - nowInSeconds(), 0)}`,
	].join("; ");
}

function clearSessionCookie(): string {
	return `${sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0`;
}

function siteUrl(env: Env, state: "success" | "denied" | "error"): URL {
	const url = new URL(env.PUBLIC_SITE_ORIGIN);
	url.pathname = "/new-feature-request/";
	url.searchParams.set("patreon_auth", state);
	return url;
}

function callbackUrl(request: Request): string {
	return new URL("/auth/patreon/callback", request.url).toString();
}

function publicTierName(tier: string): string {
	if (/^8(?:-vote)?(?:\s+tier)?$/i.test(tier.trim())) {
		return "The Ultimate Answer tier";
	}
	if (/^13(?:-vote)?(?:\s+tier)?$/i.test(tier.trim())) {
		return "The Inverse Fine-structure Constant tier";
	}
	return tier.trim();
}

function getMappedTier(identity: PatreonIdentityResponse, tierMapJson?: string): string | null {
	if (!tierMapJson) {
		return null;
	}

	let tierMap: Record<string, string>;
	try {
		tierMap = JSON.parse(tierMapJson);
	} catch {
		throw new HttpError(503, "Patreon tier mapping is invalid.");
	}

	if (!tierMap || Array.isArray(tierMap)) {
		throw new HttpError(503, "Patreon tier mapping is invalid.");
	}

	const resources = [identity.data, ...(identity.included || [])];
	const resourcesByKey = new Map(resources.map((resource) => [`${resource.type}:${resource.id}`, resource]));
	const memberships = identity.data.relationships?.memberships?.data || [];

	for (const membership of memberships) {
		const member = resourcesByKey.get(`${membership.type}:${membership.id}`);
		const tiers = member?.relationships?.currently_entitled_tiers?.data || [];
		for (const tier of tiers) {
			if (typeof tierMap[tier.id] === "string" && tierMap[tier.id].trim()) {
				return publicTierName(tierMap[tier.id]);
			}
		}
	}

	return null;
}

async function exchangeCode(request: Request, env: Env, code: string): Promise<PatreonIdentityResponse> {
	const tokenResponse = await fetch("https://www.patreon.com/api/oauth2/token", {
		body: new URLSearchParams({
			client_id: env.PATREON_CLIENT_ID,
			client_secret: env.PATREON_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: callbackUrl(request),
		}),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
	});
	if (!tokenResponse.ok) {
		throw new HttpError(502, "Patreon could not complete the login.");
	}

	const token = (await tokenResponse.json()) as { access_token?: unknown };
	if (typeof token.access_token !== "string" || !token.access_token) {
		throw new HttpError(502, "Patreon returned an invalid login response.");
	}

	const identityResponse = await fetch(
		"https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.currently_entitled_tiers",
		{ headers: { Authorization: `Bearer ${token.access_token}` } },
	);
	if (!identityResponse.ok) {
		throw new HttpError(502, "Patreon could not load membership information.");
	}

	return identityResponse.json() as Promise<PatreonIdentityResponse>;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET || !env.AUTH_HASH_KEY) {
		throw new HttpError(503, "Patreon login is not configured.");
	}

	const state = randomToken();
	const expiresAt = nowInSeconds() + stateLifetimeSeconds;
	await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(nowInSeconds()).run();
	await env.DB.prepare("INSERT INTO oauth_states (state_hash, expires_at) VALUES (?, ?)")
		.bind(await hmac(state, env.AUTH_HASH_KEY), expiresAt)
		.run();

	const authorizationUrl = new URL("https://www.patreon.com/oauth2/authorize");
	authorizationUrl.search = new URLSearchParams({
		client_id: env.PATREON_CLIENT_ID,
		redirect_uri: callbackUrl(request),
		response_type: "code",
		scope: "identity identity.memberships",
		state,
	}).toString();
	return redirect(authorizationUrl);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.searchParams.get("error")) {
		return redirect(siteUrl(env, "denied"));
	}

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return redirect(siteUrl(env, "error"));
	}

	const stateHash = await hmac(state, env.AUTH_HASH_KEY);
	const savedState = await env.DB.prepare(
		"DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING state_hash",
	)
		.bind(stateHash, nowInSeconds())
		.first<{ state_hash: string }>();
	if (!savedState) {
		return redirect(siteUrl(env, "error"));
	}

	try {
		const identity = await exchangeCode(request, env, code);
		const sessionToken = randomToken();
		const expiresAt = nowInSeconds() + sessionLifetimeSeconds;
		await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowInSeconds()).run();
		await env.DB.prepare(
			"INSERT INTO sessions (session_hash, patreon_user_hash, membership_tier, expires_at) VALUES (?, ?, ?, ?)",
		)
			.bind(
				await hmac(sessionToken, env.AUTH_HASH_KEY),
				await hmac(identity.data.id, env.AUTH_HASH_KEY),
				getMappedTier(identity, env.PATREON_TIER_MAP),
				expiresAt,
			)
			.run();

		const response = redirect(siteUrl(env, "success"));
		response.headers.append("Set-Cookie", sessionCookie(sessionToken, expiresAt));
		return response;
	} catch (error) {
		if (error instanceof HttpError) {
			return redirect(siteUrl(env, "error"));
		}
		throw error;
	}
}

async function getSession(request: Request, env: Env): Promise<Session | null> {
	const token = getCookie(request, sessionCookieName);
	if (!token) {
		return null;
	}

	const session = await env.DB.prepare(
		"SELECT patreon_user_hash, membership_tier, expires_at FROM sessions WHERE session_hash = ? AND expires_at > ?",
	)
		.bind(await hmac(token, env.AUTH_HASH_KEY), nowInSeconds())
		.first<{ patreon_user_hash: string; membership_tier: string | null; expires_at: number }>();
	if (!session) {
		return null;
	}

	return {
		expiresAt: session.expires_at,
		patreonUserHash: session.patreon_user_hash,
		tier: session.membership_tier ? publicTierName(session.membership_tier) : null,
	};
}

async function handleSession(request: Request, env: Env): Promise<Response> {
	const session = await getSession(request, env);
	if (!session) {
		return json(request, { authenticated: false });
	}

	return json(request, {
		authenticated: true,
		expiresAt: new Date(session.expiresAt * 1000).toISOString(),
		membershipTier: session.tier,
	});
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
	const token = getCookie(request, sessionCookieName);
	if (token) {
		await env.DB.prepare("DELETE FROM sessions WHERE session_hash = ?")
			.bind(await hmac(token, env.AUTH_HASH_KEY))
			.run();
	}

	const response = json(request, { authenticated: false });
	response.headers.append("Set-Cookie", clearSessionCookie());
	return response;
}

function methodNotAllowed(request: Request): Response {
	return json(request, { error: "Method not allowed." }, 405);
}

function isPiTier(tier: string | null): boolean {
	return /^pi(?:\s+tier)?$/i.test(tier?.trim() || "");
}

function requireSiteOrigin(request: Request): void {
	if (request.headers.get("Origin") !== "https://jfunk42.com") {
		throw new HttpError(403, "Requests must originate from jfunk42.com.");
	}
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("Content-Type") || "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "Requests must use JSON.");
	}

	try {
		const body = await request.json();
		if (!body || Array.isArray(body) || typeof body !== "object") {
			throw new HttpError(400, "Request body must be an object.");
		}
		return body as Record<string, unknown>;
	} catch (error) {
		if (error instanceof HttpError) {
			throw error;
		}
		throw new HttpError(400, "Request body must be valid JSON.");
	}
}

async function getPiTestSession(request: Request, env: Env): Promise<Session> {
	requireSiteOrigin(request);
	const session = await getSession(request, env);
	if (!session) {
		throw new HttpError(401, "Log in with Patreon to use Pi testing.");
	}
	if (!isPiTier(session.tier)) {
		throw new HttpError(403, "Pi testing is available to the Pi tier only.");
	}
	return session;
}

async function enforcePiTestInterval(
	env: Env,
	action: "vote" | "suggestion",
	patreonUserHash: string,
): Promise<void> {
	const now = nowInSeconds();
	const result = await env.DB.prepare(
		`INSERT INTO pi_test_limits (patreon_user_hash, action, last_used_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(patreon_user_hash, action) DO UPDATE SET last_used_at = excluded.last_used_at
		 WHERE pi_test_limits.last_used_at <= ?`,
	)
		.bind(patreonUserHash, action, now, now - piTestIntervalSeconds)
		.run();
	if (result.meta.changes !== 1) {
		throw new HttpError(429, "Try again in one hour.");
	}
}

async function handleFeatureVote(request: Request, env: Env): Promise<Response> {
	const session = await getPiTestSession(request, env);
	const body = await requestJson(request);
	const featureId = typeof body.featureId === "string" ? body.featureId : "";
	const direction = body.direction;
	if (!featureIds.has(featureId) || (direction !== "up" && direction !== "down")) {
		throw new HttpError(400, "Feature or vote direction is invalid.");
	}

	await enforcePiTestInterval(env, "vote", session.patreonUserHash);
	await env.DB.prepare(
		"INSERT INTO feature_votes (patreon_user_hash, feature_id, direction, created_at) VALUES (?, ?, ?, ?)",
	).bind(session.patreonUserHash, featureId, direction, nowInSeconds()).run();
	return json(request, { accepted: true });
}

async function handleFeatureSuggestion(request: Request, env: Env): Promise<Response> {
	const session = await getPiTestSession(request, env);
	const body = await requestJson(request);
	const suggestion = typeof body.suggestion === "string" ? body.suggestion.trim() : "";
	if (!suggestion || suggestion.length > 2000) {
		throw new HttpError(400, "Feature requests must be between 1 and 2,000 characters.");
	}

	await enforcePiTestInterval(env, "suggestion", session.patreonUserHash);
	await env.DB.prepare(
		"INSERT INTO feature_suggestions (patreon_user_hash, suggestion, created_at) VALUES (?, ?, ?)",
	).bind(session.patreonUserHash, suggestion, nowInSeconds()).run();
	return json(request, { accepted: true });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			const response = new Response(null, { status: 204 });
			addCorsHeaders(request, response.headers);
			return response;
		}

		try {
			if (url.pathname === "/health" && request.method === "GET") {
				return json(request, { ok: true });
			}
			if (url.pathname === "/auth/patreon") {
				return request.method === "GET" ? handleLogin(request, env) : methodNotAllowed(request);
			}
			if (url.pathname === "/auth/patreon/callback") {
				return request.method === "GET" ? handleCallback(request, env) : methodNotAllowed(request);
			}
			if (url.pathname === "/api/session") {
				return request.method === "GET" ? handleSession(request, env) : methodNotAllowed(request);
			}
			if (url.pathname === "/api/logout") {
				return request.method === "POST" ? handleLogout(request, env) : methodNotAllowed(request);
			}
			if (url.pathname === "/api/feature-votes") {
				return request.method === "POST" ? await handleFeatureVote(request, env) : methodNotAllowed(request);
			}
			if (url.pathname === "/api/feature-suggestions") {
				return request.method === "POST" ? await handleFeatureSuggestion(request, env) : methodNotAllowed(request);
			}
			return json(request, { error: "Not found." }, 404);
		} catch (error) {
			if (error instanceof HttpError) {
				return json(request, { error: error.message }, error.status);
			}
			console.error("Unhandled request error", error);
			return json(request, { error: "Internal server error." }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
