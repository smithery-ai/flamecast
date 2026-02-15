import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export function createDbFromUrl(databaseUrl: string) {
	const client = postgres(databaseUrl, { prepare: false })
	return drizzle(client)
}
