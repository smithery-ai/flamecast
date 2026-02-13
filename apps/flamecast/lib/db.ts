import { createDb } from "@smithery/flamecast-db"

const globalForDb = globalThis as unknown as {
	__flamecastDb: ReturnType<typeof createDb> | undefined
}

export function getDb() {
	if (!globalForDb.__flamecastDb) {
		const url = process.env.DATABASE_URL
		if (!url) {
			throw new Error("DATABASE_URL is not set")
		}
		globalForDb.__flamecastDb = createDb(url)
	}
	return globalForDb.__flamecastDb
}
