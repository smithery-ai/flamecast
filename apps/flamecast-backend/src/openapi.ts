import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { injectSchemas } from "@smithery/utils/openapi"
import { allSchemas } from "@smithery/flamecast/schemas"

type Bindings = {
	WORKOS_API_KEY: string
	WORKOS_CLIENT_ID: string
	WORKOS_COOKIE_PASSWORD: string
	REDIRECT_URI: string
	DATABASE_URL: string
}

const openAPIDocumentation = {
	info: {
		title: "Flamecast API",
		version: "1.0.0",
		description:
			"API for managing Flamecast workflow runs — register, complete, and list GitHub Actions workflow runs triggered by Flamecast.",
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http" as const,
				scheme: "bearer",
				description: "Flamecast API key as Bearer token",
			},
		},
	},
	security: [{ bearerAuth: [] }],
	tags: [
		{
			name: "workflow-runs",
			description: "Register, complete, and list GitHub Actions workflow runs",
		},
	],
}

export function createOpenAPIRoute(app: Hono<{ Bindings: Bindings }>) {
	const openAPIApp = new Hono<{ Bindings: Bindings }>()

	openAPIApp.get("/", async c => {
		const spec = await generateSpecs(app, {
			documentation: openAPIDocumentation,
		})

		injectSchemas(spec as Record<string, unknown>, allSchemas)

		return c.json(spec)
	})

	return openAPIApp
}
