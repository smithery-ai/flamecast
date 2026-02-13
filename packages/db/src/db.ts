import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index.js"

export function createConnectDb(connectionString: string) {
	const client = postgres(connectionString, { prepare: false })
	return drizzle(client, { schema })
}

export type ConnectDb = ReturnType<typeof createConnectDb>

export const createDb = createConnectDb
export type Db = ConnectDb
