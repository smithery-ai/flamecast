import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { cors } from "hono/cors"
import { WorkOS } from "@workos-inc/node"
import auth from "./routes/auth"
import workflowRuns from "./routes/workflow-runs"
import { createOpenAPIRoute } from "./openapi"

type Bindings = {
	WORKOS_API_KEY: string
	WORKOS_CLIENT_ID: string
	WORKOS_COOKIE_PASSWORD: string
	REDIRECT_URI: string
	DATABASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(
	"/workflow-runs/*",
	cors({
		origin: origin => origin,
		credentials: true,
		allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
)

app.route("/auth", auth)
app.route("/workflow-runs", workflowRuns)
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
