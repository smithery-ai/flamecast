import { createFileRoute, notFound } from '@tanstack/react-router'
import { WorkflowRunDetails } from '@/components/workflow-run-details'

export const Route = createFileRoute('/$owner/$repo/actions/runs/$runId')({
  ssr: false,
  component: WorkflowRunPage,
})

function WorkflowRunPage() {
  const { owner, repo, runId } = Route.useParams()
  const numericRunId = Number(runId)

  if (!Number.isInteger(numericRunId) || numericRunId <= 0) {
    throw notFound()
  }

  return <WorkflowRunDetails owner={owner} repo={repo} runId={numericRunId} />
}
