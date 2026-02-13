import { NextResponse } from "next/server"
import { withAuth } from "@workos-inc/authkit-nextjs"
import { and, eq } from "drizzle-orm"
import { flamecastApiKeys } from "@smithery/db-ps/schema"
import { getDb } from "@/lib/db"

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { user } = await withAuth()
	if (!user)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { id } = await params
	const db = getDb()

	await db
		.delete(flamecastApiKeys)
		.where(
			and(eq(flamecastApiKeys.id, id), eq(flamecastApiKeys.userId, user.id)),
		)

	return NextResponse.json({ success: true })
}
