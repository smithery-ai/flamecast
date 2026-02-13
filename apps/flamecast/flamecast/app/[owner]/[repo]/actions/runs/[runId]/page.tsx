import { notFound } from "next/navigation"
import { WorkflowRunDetails } from "@/components/workflow-run-details"

export default async function WorkflowRunPage({
	params,
}: {
	params: Promise<{ owner: string; repo: string; runId: string }>
}) {
	const { owner, repo, runId } = await params
	const numericRunId = Number(runId)
	if (!Number.isInteger(numericRunId) || numericRunId <= 0) notFound()

	return <WorkflowRunDetails owner={owner} repo={repo} runId={numericRunId} />
}
