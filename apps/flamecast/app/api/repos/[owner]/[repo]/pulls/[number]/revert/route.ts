import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"

export async function POST(
	_request: Request,
	{
		params,
	}: { params: Promise<{ owner: string; repo: string; number: string }> },
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo, number } = await params
	const prNumber = Number(number)
	const octokit = createOctokit(creds.accessToken)

	// Get the PR to verify it's merged
	const { data: pr } = await octokit.rest.pulls.get({
		owner,
		repo,
		pull_number: prNumber,
	})

	if (!pr.merged) {
		return NextResponse.json(
			{ error: "PR is not merged, cannot revert" },
			{ status: 400 },
		)
	}

	if (!pr.merge_commit_sha) {
		return NextResponse.json(
			{ error: "No merge commit found" },
			{ status: 400 },
		)
	}

	// Get the default branch
	const { data: repoData } = await octokit.rest.repos.get({
		owner,
		repo,
	})
	const defaultBranch = repoData.default_branch

	// Create a revert commit
	const { data: revertCommit } = await octokit.rest.repos.createCommitComment({
		owner,
		repo,
		commit_sha: pr.merge_commit_sha,
		body: `Reverting PR #${prNumber}`,
	})

	// Use the GitHub API to create a revert
	// Note: GitHub doesn't have a direct revert API, so we'll create a new PR that reverts the changes
	const revertBranchName = `revert-${prNumber}-${Date.now()}`

	// Get the base commit (the commit before the merge)
	const { data: baseRef } = await octokit.rest.git.getRef({
		owner,
		repo,
		ref: `heads/${defaultBranch}`,
	})

	// Create a new branch for the revert
	await octokit.rest.git.createRef({
		owner,
		repo,
		ref: `refs/heads/${revertBranchName}`,
		sha: baseRef.object.sha,
	})

	// Create a revert commit using git revert
	try {
		// Get the tree of the commit before the merge
		const { data: mergeCommit } = await octokit.rest.git.getCommit({
			owner,
			repo,
			commit_sha: pr.merge_commit_sha,
		})

		// For a merge commit, the first parent is the branch it was merged into
		const parentSha = mergeCommit.parents[0].sha
		const { data: parentCommit } = await octokit.rest.git.getCommit({
			owner,
			repo,
			commit_sha: parentSha,
		})

		// Create a new commit with the parent's tree (effectively reverting)
		const { data: newCommit } = await octokit.rest.git.createCommit({
			owner,
			repo,
			message: `Revert PR #${prNumber}: ${pr.title}`,
			tree: parentCommit.tree.sha,
			parents: [baseRef.object.sha],
		})

		// Update the revert branch to point to the new commit
		await octokit.rest.git.updateRef({
			owner,
			repo,
			ref: `heads/${revertBranchName}`,
			sha: newCommit.sha,
		})

		// Create a new PR for the revert
		const { data: revertPr } = await octokit.rest.pulls.create({
			owner,
			repo,
			title: `Revert PR #${prNumber}: ${pr.title}`,
			head: revertBranchName,
			base: defaultBranch,
			body: `This reverts pull request #${prNumber}.`,
		})

		const posthog = getPostHogClient()
		posthog.capture({
			distinctId: creds.userId,
			event: "pr_reverted",
			properties: {
				repo: `${owner}/${repo}`,
				pr_number: prNumber,
				revert_pr_number: revertPr.number,
			},
		})

		return NextResponse.json({
			success: true,
			reverted: true,
			revertPrNumber: revertPr.number,
			revertPrUrl: revertPr.html_url,
		})
	} catch (error) {
		// Clean up the branch if something went wrong
		try {
			await octokit.rest.git.deleteRef({
				owner,
				repo,
				ref: `heads/${revertBranchName}`,
			})
		} catch {
			// Ignore cleanup errors
		}

		throw error
	}
}
