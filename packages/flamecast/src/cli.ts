#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process"
import { setTimeout } from "node:timers/promises"

const REPO = "smithery-ai/flamecast"

const ADJECTIVES = [
	"amber",
	"bold",
	"calm",
	"dark",
	"eager",
	"fair",
	"glad",
	"hazy",
	"icy",
	"keen",
	"lush",
	"mild",
	"neat",
	"pale",
	"quick",
	"rare",
	"slim",
	"tall",
	"vast",
	"warm",
	"zany",
	"deft",
	"epic",
	"firm",
	"grim",
	"idle",
	"jade",
	"loud",
	"neon",
	"opal",
]

const ANIMALS = [
	"falcon",
	"panda",
	"otter",
	"eagle",
	"whale",
	"tiger",
	"raven",
	"koala",
	"bison",
	"crane",
	"gecko",
	"heron",
	"lemur",
	"moose",
	"quail",
	"robin",
	"shark",
	"viper",
	"wren",
	"yak",
	"cobra",
	"dingo",
	"finch",
	"goose",
	"hawk",
	"ibis",
	"jackal",
	"llama",
	"newt",
	"owl",
]

interface Step {
	name: string
	status: string
	conclusion: string | null
	number: number
}

interface Job {
	databaseId: number
	status: string
	conclusion: string | null
	steps: Step[]
}

interface PRCheckStatus {
	state: string
}

interface PRListItem {
	number: number
	title: string
	headRefName: string
	statusCheckRollup: PRCheckStatus[]
}

// --- Helpers ---

let _cachedUsername: string | undefined

function getGitHubUsername(): string {
	if (_cachedUsername) return _cachedUsername
	const result = spawnSync("gh", ["api", "user", "--jq", ".login"], {
		encoding: "utf-8",
	})
	if (result.status !== 0 || !result.stdout.trim()) {
		console.error(
			"Failed to get GitHub username. Make sure `gh` is authenticated.",
		)
		process.exit(1)
	}
	_cachedUsername = result.stdout.trim()
	return _cachedUsername
}

function generateBranchName(): string {
	const username = getGitHubUsername()
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
	const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
	const num = Math.floor(Math.random() * 100)
	return `flamecast/${username}/${adj}-${animal}-${num}`
}

function detectBaseBranch(targetRepo?: string): string {
	if (targetRepo) return "main"
	const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		encoding: "utf-8",
	})
	if (result.status !== 0 || !result.stdout.trim()) {
		console.warn(
			"Failed to determine current git branch. Defaulting to 'main'.",
		)
		return "main"
	}
	const currentBranch = result.stdout.trim()

	const lsResult = spawnSync(
		"git",
		["ls-remote", "--exit-code", "--heads", "origin", currentBranch],
		{ encoding: "utf-8" },
	)

	if (lsResult.status === 0) {
		return currentBranch
	}

	console.warn(
		`Warning: branch '${currentBranch}' not found on remote. Defaulting to 'main'.`,
	)
	return "main"
}

function gh(...args: string[]): string | undefined {
	const result = spawnSync("gh", args, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
	})
	if (result.status !== 0) return undefined
	return result.stdout
}

function findRunId(branch: string): string | undefined {
	const out = gh(
		"run",
		"list",
		"-R",
		REPO,
		"-w",
		"flamecast.yml",
		"--json",
		"databaseId,headBranch,status",
		"-L",
		"5",
	)
	if (!out) return undefined
	const runs = JSON.parse(out) as {
		databaseId: number
		headBranch: string
		status: string
	}[]
	const run = runs.find(
		r =>
			r.headBranch === branch ||
			r.status === "queued" ||
			r.status === "in_progress",
	)
	return run ? String(run.databaseId) : undefined
}

function getJobs(runId: string): Job[] {
	const out = gh("run", "view", runId, "-R", REPO, "--json", "jobs")
	if (!out) return []
	return (JSON.parse(out) as { jobs: Job[] }).jobs
}

function getRunLog(runId: string): string {
	return gh("run", "view", runId, "-R", REPO, "--log") ?? ""
}

function stripTimestamp(line: string): string {
	return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
}

function aggregateCIStatus(checks: PRCheckStatus[] | null): string {
	if (!checks || checks.length === 0) return "no checks"
	if (checks.some(c => c.state === "FAILURE" || c.state === "ERROR"))
		return "failed"
	if (checks.some(c => c.state === "PENDING" || c.state === "EXPECTED"))
		return "pending"
	return "passed"
}

// --- Commands ---

function parsePRNumber(arg: string | undefined): number {
	if (!arg) {
		console.error("Usage: ff <command> <PR number>")
		process.exit(1)
	}
	const num = Number.parseInt(arg.replace(/^#/, ""), 10)
	if (Number.isNaN(num)) {
		console.error(`Invalid PR number: ${arg}`)
		process.exit(1)
	}
	return num
}

function handleCheckout(prNumber: number): void {
	console.log(`Checking out PR #${prNumber}...`)
	const result = spawnSync(
		"gh",
		["pr", "checkout", String(prNumber), "-R", REPO],
		{ stdio: "inherit" },
	)
	if (result.status !== 0) {
		console.error(`Failed to checkout PR #${prNumber}.`)
		process.exit(1)
	}
}

function handleMerge(prNumber: number): void {
	console.log(`Merging PR #${prNumber}...`)
	const result = spawnSync(
		"gh",
		[
			"pr",
			"merge",
			String(prNumber),
			"-R",
			REPO,
			"--squash",
			"--delete-branch",
		],
		{ stdio: "inherit" },
	)
	if (result.status !== 0) {
		console.error(`Failed to merge PR #${prNumber}.`)
		process.exit(1)
	}
}

function handleClose(prNumber: number): void {
	console.log(`Closing PR #${prNumber}...`)
	const result = spawnSync(
		"gh",
		["pr", "close", String(prNumber), "-R", REPO, "--delete-branch"],
		{ stdio: "inherit" },
	)
	if (result.status !== 0) {
		console.error(`Failed to close PR #${prNumber}.`)
		process.exit(1)
	}
}

async function handleLs(meOnly: boolean): Promise<void> {
	const prefix = meOnly ? `flamecast/${getGitHubUsername()}/` : "flamecast/"

	const out = gh(
		"pr",
		"list",
		"-R",
		REPO,
		"--search",
		`head:${prefix}`,
		"--json",
		"number,title,headRefName,statusCheckRollup",
		"--state",
		"open",
	)

	if (!out) {
		console.error("Failed to list PRs.")
		process.exit(1)
	}

	const prs = JSON.parse(out) as PRListItem[]

	if (prs.length === 0) {
		console.log("No open flamecast PRs found.")
		return
	}

	for (const pr of prs) {
		const status = aggregateCIStatus(pr.statusCheckRollup)
		const num = `#${pr.number}`.padStart(6)
		console.log(`${num}  ${status}  ${pr.title}`)
	}
}

// --- Arg parsing ---

const args = process.argv.slice(2)
let useCurrentBranch = false
let global = false
let targetRepo: string | undefined
const positional: string[] = []

for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (arg === "--branch") {
		useCurrentBranch = true
	} else if (arg === "--global") {
		global = true
	} else if (arg === "--repo") {
		targetRepo = args[++i]
		if (!targetRepo) {
			console.error("--repo requires a value (e.g. --repo kamath/dotcom.chat)")
			process.exit(1)
		}
	} else {
		positional.push(arg)
	}
}

const subcommand = positional[0]

if (subcommand === "ls") {
	await handleLs(!global)
} else if (subcommand === "co") {
	const prNumber = parsePRNumber(positional[1])
	handleCheckout(prNumber)
} else if (subcommand === "merge") {
	const prNumber = parsePRNumber(positional[1])
	handleMerge(prNumber)
} else if (subcommand === "close") {
	const prNumber = parsePRNumber(positional[1])
	handleClose(prNumber)
} else {
	const prompt = positional.join(" ").trim()

	if (!prompt) {
		console.error("Usage:")
		console.error("  ff [--branch] [--repo owner/name] <prompt>")
		console.error("                           Trigger a flamecast workflow")
		console.error(
			"  ff ls [--global]         List open flamecast PRs (default: yours only)",
		)
		console.error("  ff co <PR#>              Checkout a PR locally")
		console.error("  ff merge <PR#>           Merge a PR (squash)")
		console.error("  ff close <PR#>           Close a PR")
		console.error()
		console.error("Options:")
		console.error(
			"  --repo owner/name  Target a different repo (e.g. kamath/dotcom.chat)",
		)
		console.error("  --branch           Use current git branch as workflow ref")
		process.exit(1)
	}

	let ref: string | undefined
	if (useCurrentBranch) {
		const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf-8",
		})
		if (result.status !== 0 || !result.stdout.trim()) {
			console.error("Failed to determine current git branch.")
			process.exit(1)
		}
		ref = result.stdout.trim()
	}

	const branch = generateBranchName()
	const baseBranch = detectBaseBranch(targetRepo)

	console.log(`Branch: ${branch}`)
	console.log(`Base:   ${baseBranch}`)
	if (ref) console.log(`Ref:    ${ref}`)
	if (targetRepo) console.log(`Repo:   ${targetRepo}`)
	console.log(`Prompt: ${prompt}`)
	console.log()

	try {
		const baseGhArgs = [
			"workflow",
			"run",
			"flamecast.yml",
			"-R",
			REPO,
			"-f",
			`branch_name=${branch}`,
			"-f",
			`prompt=${prompt}`,
		]
		if (ref) {
			baseGhArgs.push("--ref", ref)
		}
		if (targetRepo) {
			baseGhArgs.push("-f", `target_repo=${targetRepo}`)
		}

		// Try with base_branch first; fall back without it if the workflow doesn't support it yet
		let dispatched = false
		if (baseBranch !== "main") {
			const withBase = [...baseGhArgs, "-f", `base_branch=${baseBranch}`]
			const result = spawnSync("gh", withBase, { encoding: "utf-8" })
			if (result.status === 0) {
				dispatched = true
			} else if (
				result.stderr?.includes("Unexpected inputs") &&
				result.stderr?.includes("base_branch")
			) {
				console.warn(
					"Warning: remote workflow does not support base_branch yet. Falling back to main.",
				)
			} else if (result.status !== 0) {
				// Some other error — let execFileSync throw it
				execFileSync("gh", withBase, { stdio: "inherit" })
			}
		}
		if (!dispatched) {
			execFileSync("gh", baseGhArgs, { stdio: "inherit" })
		}

		console.log("Workflow triggered. Waiting for run to start...")

		let runId: string | undefined
		for (let i = 0; i < 15; i++) {
			await setTimeout(2000)
			runId = findRunId(branch)
			if (runId) break
		}

		if (!runId) {
			console.log(
				"Could not find run ID. Check: https://github.com/smithery-ai/mono/actions",
			)
			process.exit(0)
		}

		console.log(`Run:    https://github.com/${REPO}/actions/runs/${runId}\n`)

		const seenSteps = new Set<string>()

		while (true) {
			const jobs = getJobs(runId)
			if (!jobs.length) {
				await setTimeout(2000)
				continue
			}

			const job = jobs[0]

			for (const step of job.steps) {
				const key = `${step.number}:${step.conclusion ?? step.status}`
				if (seenSteps.has(key)) continue
				seenSteps.add(key)

				if (step.conclusion === "success") {
					console.log(`  ✓ ${step.name}`)
				} else if (step.conclusion === "failure") {
					console.log(`  ✗ ${step.name}`)
				} else if (step.status === "in_progress") {
					console.log(`  ▶ ${step.name}`)
				}
			}

			if (job.status === "completed") {
				console.log()

				const fullLog = getRunLog(runId)
				if (fullLog) {
					const lines = fullLog.split("\n")
					let inClaudeStep = false
					for (const raw of lines) {
						const parts = raw.split("\t")
						if (parts.length >= 2) {
							const stepName = parts[1].trim()
							if (stepName === "Run Claude Code") {
								inClaudeStep = true
								const rest = parts.slice(2).join("\t")
								const line = stripTimestamp(rest).trimEnd()
								if (line && !line.startsWith("##[")) {
									console.log(`    ${line}`)
								}
							} else if (inClaudeStep) {
								break
							}
						}
					}
				}

				if (job.conclusion === "success") {
					console.log("✓ Run succeeded")

					// Show PR link if one was created
					const prOut = gh(
						"pr",
						"list",
						"-R",
						targetRepo || REPO,
						"--head",
						branch,
						"--json",
						"number,url",
						"--state",
						"open",
					)
					if (prOut) {
						const prs = JSON.parse(prOut) as { number: number; url: string }[]
						if (prs.length > 0) {
							console.log(`PR:     ${prs[0].url}`)
						}
					}
				} else {
					console.log(`✗ Run ${job.conclusion}`)
					process.exit(1)
				}
				break
			}

			await setTimeout(3000)
		}
	} catch {
		console.error("Failed to trigger workflow.")
		console.error(
			"Make sure `gh` is installed and authenticated: gh auth status",
		)
		process.exit(1)
	}
}
