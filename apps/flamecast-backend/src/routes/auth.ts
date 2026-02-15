import { Hono } from "hono"
import type { Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { eq } from "drizzle-orm"
import { WorkOS } from "@workos-inc/node"
import { flamecastApiKeys } from "@smithery/flamecast-db/schema"
import { createDbFromUrl } from "../lib/db"

const auth = new Hono<{ Bindings: Env }>()
const RETURN_TO_COOKIE = "wos-return-to"
const RETURN_TO_COOKIE_MAX_AGE_SECONDS = 60 * 10

interface AuthState {
	returnTo?: string
}

function parseState(rawState: string | undefined): AuthState {
	if (!rawState) return {}
	try {
		const parsed = JSON.parse(rawState)
		if (!parsed || typeof parsed !== "object") return {}
		const returnTo =
			"returnTo" in parsed && typeof parsed.returnTo === "string"
				? parsed.returnTo
				: undefined
		return { returnTo }
	} catch {
		return {}
	}
}

function normalizeAppOrigin(value: string | undefined): string | null {
	if (!value) return null
	try {
		const parsed = new URL(value)
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null
		}
		return parsed.origin
	} catch {
		return null
	}
}

function normalizeReturnTo(
	value: string | undefined,
	appOrigin: string | null,
): string {
	if (!value) return "/"

	try {
		const parsed = new URL(value)
		if (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			appOrigin &&
			parsed.origin === appOrigin
		) {
			return parsed.toString()
		}
		return "/"
	} catch {
		if (value.startsWith("/")) return value
		return "/"
	}
}

function toAbsoluteReturnTo(value: string, appOrigin: string | null): string {
	if (!appOrigin) return ""
	try {
		const parsed = new URL(value)
		return parsed.toString()
	} catch {
		if (value.startsWith("/")) {
			return new URL(value, appOrigin).toString()
		}
		return ""
	}
}

function resolvePostAuthReturnTo(
	c: Context<{ Bindings: Env }>,
	state: AuthState,
): string {
	return state.returnTo || getCookie(c, RETURN_TO_COOKIE) || "/"
}

function resolveSessionCookieSettings(
	c: Context<{ Bindings: Env }>,
	returnTo: string,
): { secure: boolean; sameSite: "Lax" | "None" } {
	const requestUrl = new URL(c.req.url)
	const secure = requestUrl.protocol === "https:"
	if (!secure) return { secure: false, sameSite: "Lax" }

	try {
		const returnToUrl = new URL(returnTo)
		if (returnToUrl.origin !== requestUrl.origin) {
			return { secure: true, sameSite: "None" }
		}
	} catch {
		// Relative returnTo paths should keep Lax behavior.
	}

	return { secure: true, sameSite: "Lax" }
}

type LegacyWorkOSEnv = Env & {
	NEXT_PUBLIC_WORKOS_REDIRECT_URI?: string
}

function resolveWorkosRedirectUri(c: Context<{ Bindings: Env }>): string | null {
	const env = c.env as LegacyWorkOSEnv
	const redirectUri = env.WORKOS_REDIRECT_URI || env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
	if (!redirectUri) return null

	try {
		const parsed = new URL(redirectUri)
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
		return parsed.toString()
	} catch {
		return null
	}
}

async function authenticateSession(
	c: Context<{ Bindings: Env }>,
): Promise<{
	id: string
	email: string
	firstName: string | null
	lastName: string | null
	profilePictureUrl: string | null
} | null> {
	try {
		const workos = new WorkOS(c.env.WORKOS_API_KEY, {
			clientId: c.env.WORKOS_CLIENT_ID,
		})

		const session = workos.userManagement.loadSealedSession({
			sessionData: getCookie(c, "wos-session") ?? "",
			cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
		})

		const authResult = await session.authenticate()
		if (!authResult.authenticated) return null

		return {
			id: authResult.user.id,
			email: authResult.user.email,
			firstName: authResult.user.firstName,
			lastName: authResult.user.lastName,
			profilePictureUrl: authResult.user.profilePictureUrl,
		}
	} catch {
		return null
	}
}

auth.get("/login", c => {
	const redirectUri = resolveWorkosRedirectUri(c)
	if (!redirectUri) {
		return c.json(
			{
				error:
					"WorkOS is not configured. Set WORKOS_REDIRECT_URI (or NEXT_PUBLIC_WORKOS_REDIRECT_URI) to an absolute callback URL.",
			},
			500,
		)
	}

	const workos = new WorkOS(c.env.WORKOS_API_KEY, {
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	const appOrigin = normalizeAppOrigin(c.req.query("appOrigin"))
	const returnTo = normalizeReturnTo(c.req.query("returnTo"), appOrigin)
	const state = JSON.stringify({ returnTo })
	setCookie(c, RETURN_TO_COOKIE, returnTo, {
		path: "/",
		httpOnly: true,
		secure: new URL(c.req.url).protocol === "https:",
		sameSite: "Lax",
		maxAge: RETURN_TO_COOKIE_MAX_AGE_SECONDS,
	})

	const authorizationUrl = workos.userManagement.getAuthorizationUrl({
		provider: "authkit",
		redirectUri,
		clientId: c.env.WORKOS_CLIENT_ID,
		state,
	})

	return c.redirect(authorizationUrl)
})

auth.get("/callback", async c => {
	const code = c.req.query("code")

	if (!code) {
		return c.text("No code provided", 400)
	}

	const state = parseState(c.req.query("state"))
	const returnTo = resolvePostAuthReturnTo(c, state)

	try {
		const workos = new WorkOS(c.env.WORKOS_API_KEY, {
			clientId: c.env.WORKOS_CLIENT_ID,
		})

		const { sealedSession } = await workos.userManagement.authenticateWithCode({
			code,
			clientId: c.env.WORKOS_CLIENT_ID,
			session: {
				sealSession: true,
				cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
			},
		})

		const sessionCookieSettings = resolveSessionCookieSettings(c, returnTo)
		setCookie(c, "wos-session", sealedSession!, {
			path: "/",
			httpOnly: true,
			secure: sessionCookieSettings.secure,
			sameSite: sessionCookieSettings.sameSite,
		})
		deleteCookie(c, RETURN_TO_COOKIE, { path: "/" })

		return c.redirect(returnTo)
	} catch {
		const retry = new URL("/auth/login", c.req.url)
		retry.searchParams.set("returnTo", returnTo)
		try {
			retry.searchParams.set("appOrigin", new URL(returnTo).origin)
		} catch {
			// Ignore relative returnTo values for appOrigin.
		}
		return c.redirect(retry.toString())
	}
})

auth.get("/logout", async c => {
	const workos = new WorkOS(c.env.WORKOS_API_KEY, {
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	const appOrigin = normalizeAppOrigin(c.req.query("appOrigin"))
	const returnTo = normalizeReturnTo(c.req.query("returnTo"), appOrigin)
	const absoluteReturnTo = toAbsoluteReturnTo(returnTo, appOrigin)

	try {
		const session = workos.userManagement.loadSealedSession({
			sessionData: getCookie(c, "wos-session") ?? "",
			cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
		})

		const url = await session.getLogoutUrl(
			absoluteReturnTo ? { returnTo: absoluteReturnTo } : undefined,
		)

		deleteCookie(c, "wos-session", { path: "/" })
		return c.redirect(url)
	} catch {
		deleteCookie(c, "wos-session", { path: "/" })
		return c.redirect(absoluteReturnTo || "/")
	}
})

auth.get("/me", async c => {
	const user = await authenticateSession(c)
	if (!user) return c.json({ error: "Unauthorized" }, 401)
	return c.json({ user })
})

auth.get("/api-key", async c => {
	const user = await authenticateSession(c)
	if (!user) return c.json({ error: "Unauthorized" }, 401)

	const db = createDbFromUrl(c.env.DATABASE_URL)
	const [existingKey] = await db
		.select({ key: flamecastApiKeys.key })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, user.id))
		.limit(1)

	if (existingKey?.key) {
		return c.json({ apiKey: existingKey.key, userId: user.id })
	}

	const [createdKey] = await db
		.insert(flamecastApiKeys)
		.values({
			userId: user.id,
			name: "Web app",
			description: "Auto-generated key for frontend sessions",
		})
		.returning({ key: flamecastApiKeys.key })

	return c.json({ apiKey: createdKey.key, userId: user.id })
})

export default auth
