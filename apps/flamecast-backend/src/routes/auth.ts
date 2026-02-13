import { Hono } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { WorkOS } from "@workos-inc/node"

type Bindings = {
	WORKOS_API_KEY: string
	WORKOS_CLIENT_ID: string
	WORKOS_COOKIE_PASSWORD: string
	REDIRECT_URI: string
}

const auth = new Hono<{ Bindings: Bindings }>()

auth.get("/login", c => {
	const workos = new WorkOS(c.env.WORKOS_API_KEY, {
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	const authorizationUrl = workos.userManagement.getAuthorizationUrl({
		provider: "authkit",
		redirectUri: `${c.env.REDIRECT_URI}/auth/callback`,
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	return c.redirect(authorizationUrl)
})

auth.get("/callback", async c => {
	const code = c.req.query("code")

	if (!code) {
		return c.text("No code provided", 400)
	}

	try {
		const workos = new WorkOS(c.env.WORKOS_API_KEY, {
			clientId: c.env.WORKOS_CLIENT_ID,
		})

		const { user, sealedSession } =
			await workos.userManagement.authenticateWithCode({
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
			secure: true,
			sameSite: "Lax",
		})

		return c.redirect("/")
	} catch (error) {
		return c.redirect("/auth/login")
	}
})

auth.get("/logout", async c => {
	const workos = new WorkOS(c.env.WORKOS_API_KEY, {
		clientId: c.env.WORKOS_CLIENT_ID,
	})

	const session = workos.userManagement.loadSealedSession({
		sessionData: getCookie(c, "wos-session") ?? "",
		cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
	})

	const url = await session.getLogoutUrl()

	deleteCookie(c, "wos-session")
	return c.redirect(url)
})

export default auth
