import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

import { defineConfig } from "drizzle-kit"

export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./src/migrations",
	dialect: "postgresql",
	schemaFilter: ["flamecast"],
	dbCredentials: {
		url: process.env.DATABASE_URL!,
	},
})
