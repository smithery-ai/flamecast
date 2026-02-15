import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { cors } from "hono/cors"
import { WorkOS } from "@workos-inc/node"
import auth from "./routes/auth"
import workflowRuns from "./routes/workflow-runs"
import apiKeys from "./routes/api-keys"
import githubRepos from "./routes/github-repos"
import setup from "./routes/setup"
import chats from "./routes/chats"
import { createOpenAPIRoute } from "./openapi"

export type Bindings = {
	WORKOS_API_KEY: string
	WORKOS_CLIENT_ID: string
	WORKOS_COOKIE_PASSWORD: string
	WORKOS_REDIRECT_URI: string
	DATABASE_URL: string
	POSTHOG_KEY: string
	POSTHOG_HOST: string
}

const app = new Hono<{ Bindings: Bindings }>()

const corsMiddleware = cors({
	origin: origin => origin,
	credentials: true,
	allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
})

app.use("/workflow-runs/*", corsMiddleware)
app.use("/api-keys/*", corsMiddleware)
app.use("/github/*", corsMiddleware)
app.use("/setup/*", corsMiddleware)
app.use("/chats/*", corsMiddleware)
app.use("/auth/*", corsMiddleware)

app.route("/auth", auth)
app.route("/workflow-runs", workflowRuns)
app.route("/api-keys", apiKeys)
app.route("/github", githubRepos)
app.route("/setup", setup)
app.route("/chats", chats)
app.route("/openapi", createOpenAPIRoute(app))

app.get("/", async c => {
	let user = null

	try {
		const workos = new WorkOS(c.env.WORKOS_API_KEY, {
			clientId: c.env.WORKOS_CLIENT_ID,
		})

		const session = workos.userManagement.loadSealedSession({
			sessionData: getCookie(c, "wos-session") ?? "",
			cookiePassword: c.env.WORKOS_COOKIE_PASSWORD,
		})

		const authResult = await session.authenticate()
		if (authResult.authenticated) {
			user = authResult.user
		}
	} catch (e) {
		// Not authenticated, user stays null
	}

	if (user) {
		return c.text(`Welcome, ${user.email}!`)
	}

	return c.text("Hello Hono!")
})

export default app
