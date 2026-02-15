import { Hono } from "hono"
import type { Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { eq } from "drizzle-orm"
import { WorkOS } from "@workos-inc/node"
import { flamecastApiKeys } from "@smithery/flamecast-db/schema"
import { createDbFromUrl } from "../lib/db"

const auth = new Hono<{ Bindings: Env }>()

interface AuthState {
	returnTo?: string
}

function parseState(rawState: string | undefined): AuthState {
	if (!rawState) return {}
	try {
		const parsed = JSON.parse(rawState)
		if (!parsed || typeof parsed !== "object") return {}
		return parsed as AuthState
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
	const workos = new WorkOS(c.env.WORKOS_API_KEY, {
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	const appOrigin = normalizeAppOrigin(c.req.query("appOrigin"))
	const returnTo = normalizeReturnTo(c.req.query("returnTo"), appOrigin)
	const state = JSON.stringify({ returnTo })

	const authorizationUrl = workos.userManagement.getAuthorizationUrl({
		provider: "authkit",
		redirectUri: c.env.WORKOS_REDIRECT_URI,
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

		setCookie(c, "wos-session", sealedSession!, {
			path: "/",
			httpOnly: true,
			secure: new URL(c.req.url).protocol === "https:",
			sameSite: "Lax",
		})

		return c.redirect(state.returnTo || "/")
	} catch {
		return c.redirect("/auth/login")
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
