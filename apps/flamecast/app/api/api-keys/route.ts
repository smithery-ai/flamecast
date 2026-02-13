import { type NextRequest, NextResponse } from "next/server"
import { withAuth } from "@workos-inc/authkit-nextjs"
import { eq } from "drizzle-orm"
import { flamecastApiKeys } from "@smithery/flamecast-db/schema"
import { getDb } from "@/lib/db"

const MAX_API_KEYS = 20

export async function GET() {
	const { user } = await withAuth()
	if (!user)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const db = getDb()
	const keys = await db
		.select({
			id: flamecastApiKeys.id,
			name: flamecastApiKeys.name,
			description: flamecastApiKeys.description,
			createdAt: flamecastApiKeys.createdAt,
		})
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, user.id))
		.orderBy(flamecastApiKeys.createdAt)

	return NextResponse.json({ keys })
}

export async function POST(request: NextRequest) {
	const { user } = await withAuth()
	if (!user)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const body = await request.json()
	const { name, description } = body

	const db = getDb()

	const existing = await db
		.select({ id: flamecastApiKeys.id })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, user.id))

	if (existing.length >= MAX_API_KEYS) {
		return NextResponse.json(
			{ error: "Maximum number of API keys reached (20)" },
			{ status: 400 },
		)
	}

	const [newKey] = await db
		.insert(flamecastApiKeys)
		.values({
			userId: user.id,
			name: name || null,
			description: description || null,
		})
		.returning({
			id: flamecastApiKeys.id,
			key: flamecastApiKeys.key,
		})

	return NextResponse.json({ key: newKey.key, id: newKey.id })
}
