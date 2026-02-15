export const FLAMECAST_WORKFLOW_PATH = ".github/workflows/flamecast.yml"

export const FLAMECAST_WORKFLOW_CONTENT = `name: Flamecast

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: "Prompt for Claude Code"
        required: true
        type: string
      base_branch:
        description: "Base branch for the PR"
        required: false
        type: string
        default: "main"
      target_repo:
        description: "Target repo (e.g. owner/repo). Leave empty for current repo."
        required: false
        type: string
      sync_base:
        description: "Merge base branch into feature branch and resolve conflicts"
        required: false
        type: boolean
        default: false

jobs:
  flamecast:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Register workflow run
        id: register
        run: |
          PAYLOAD=$(jq -n \\
            --argjson workflowRunId \${{ github.run_id }} \\
            --arg repo "\${{ inputs.target_repo || github.repository }}" \\
            --arg sourceRepo "\${{ github.repository }}" \\
            --arg prompt "\${{ inputs.prompt }}" \\
            '{workflowRunId: $workflowRunId, repo: $repo, sourceRepo: $sourceRepo, prompt: $prompt}')
          RESPONSE=$(curl -s -X POST \\
            -H "Authorization: Bearer \${{ secrets.FLAMECAST_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d "$PAYLOAD" \\
            "https://api.flamecast.dev/workflow-runs")
          echo "run_db_id=$(echo $RESPONSE | jq -r '.id')" >> $GITHUB_OUTPUT
      - uses: smithery-ai/flamecast@v1
        id: flamecast
        with:
          prompt: \${{ inputs.prompt }}
          base_branch: \${{ inputs.base_branch }}
          target_repo: \${{ inputs.target_repo }}
          sync_base: \${{ inputs.sync_base }}
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          flamecast_pat: \${{ secrets.FLAMECAST_PAT }}
      - name: Persist flamecast outputs
        if: always()
        run: |
          mkdir -p "$RUNNER_TEMP/flamecast"
          cat > "$RUNNER_TEMP/flamecast/outputs.json" <<EOF
          {
            "pr_url": \${{ toJson(steps.flamecast.outputs.pr_url) }},
            "claude_logs": \${{ toJson(steps.flamecast.outputs.claude_logs) }}
          }
          EOF
      - name: Upload flamecast outputs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flamecast-outputs
          path: \${{ runner.temp }}/flamecast/outputs.json
          retention-days: 1
      - name: Report completion
        if: always()
        run: |
          curl -s -X PATCH \\
            -H "Authorization: Bearer \${{ secrets.FLAMECAST_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            "https://api.flamecast.dev/workflow-runs/\${{ steps.register.outputs.run_db_id }}" || true
`

export function getFlamecastWorkflowContentBase64() {
	return Buffer.from(FLAMECAST_WORKFLOW_CONTENT).toString("base64")
}
