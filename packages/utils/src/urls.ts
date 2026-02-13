/**
 * Parse a qualified name into namespace and slug.
 * Handles: "exa", "anthropic/github", "@anthropic/github"
 */
export function parseQualifiedName(qualifiedName: string) {
	let name = qualifiedName
	if (name.startsWith("@")) {
		name = name.slice(1)
	}
	const parts = name.split("/")
	return {
		namespace: parts[0].toLowerCase(),
		slug: parts.length > 1 ? parts[1].toLowerCase() : "",
	}
}

/**
 * Convert a qualified name to a run.tools subdomain URL (nested format, deprecated).
 * - "exa" → "https://exa.run.tools"
 * - "anthropic/github" → "https://github.anthropic.run.tools"
 * - "@anthropic/github" → "https://github.anthropic.run.tools"
 */
export function toSubdomainUrl(qualifiedName: string, customDomain?: string) {
	if (customDomain) {
		return `https://${customDomain}`
	}
	const { namespace, slug } = parseQualifiedName(qualifiedName)
	if (slug) {
		return `https://${slug}.${namespace}.run.tools`
	}
	return `https://${namespace}.run.tools`
}

/**
 * Compute the default runToolsSlug for a server from its qualified name.
 * - "exa" → "exa"
 * - "anthropic/github" → "github--anthropic"
 * - "@anthropic/github" → "github--anthropic"
 */
export function computeDefaultRunToolsSlug(qualifiedName: string) {
	const { namespace, slug } = parseQualifiedName(qualifiedName)
	if (slug) {
		return `${slug}--${namespace}`
	}
	return namespace
}

/**
 * Build a flat run.tools URL from a runToolsSlug.
 * - "exa" → "https://exa.run.tools"
 * - "github--anthropic" → "https://github--anthropic.run.tools"
 */
export function toRunToolsUrl(runToolsSlug: string, customDomain?: string) {
	if (customDomain) {
		return `https://${customDomain}`
	}
	return `https://${runToolsSlug}.run.tools`
}

/**
 * Get legacy gateway MCP URL using the old server.smithery.ai path format.
 *
 * This is a safe fallback when only a qualifiedName is available (no DB access).
 * The gateway resolves both legacy and run.tools formats.
 *
 * For canonical run.tools URLs, use `toRunToolsUrl(server.runToolsSlug)` with
 * the DB-stored `runToolsSlug` instead — the slug may be customized by the
 * server owner and cannot be derived from the qualifiedName alone.
 */
export function getLegacyGatewayMcpUrl(qualifiedName: string) {
	return `https://server.smithery.ai/${qualifiedName}`
}

/**
 * Servers that don't require authentication headers
 * (e.g., premium customers hosting with us who allow public access)
 */
export const SERVERS_WITHOUT_AUTH = new Set([
	"exa",
	// Add more premium/public servers here
])

export function requiresAuthHeader(qualifiedName: string): boolean {
	return !SERVERS_WITHOUT_AUTH.has(qualifiedName)
}

export type ParsedGithubUrl = {
	owner: string
	repo: string
	subpath?: string
	branch: string
}

/**
 * Parse a GitHub URL to extract owner, repo, subpath, and branch.
 * Handles both full URLs and shorthand formats (e.g., "owner/repo").
 * Supports tree/branch/path and blob/branch/path formats.
 */
export function parseGithubUrl(url: string): ParsedGithubUrl | null {
	try {
		const normalized = url.startsWith("http")
			? url
			: `https://github.com/${url}`
		const urlObj = new URL(normalized)

		if (urlObj.hostname !== "github.com") return null

		const pathParts = urlObj.pathname.split("/").filter(Boolean)
		if (pathParts.length < 2) return null

		// GitHub URLs are case-insensitive for owner/repo, so normalize to lowercase
		const owner = pathParts[0].toLowerCase()
		const repo = pathParts[1].replace(/\.git$/, "").toLowerCase()

		let branch: string | undefined
		let subpath: string | undefined

		// Parse tree/branch/path or blob/branch/path format
		// GitHub uses "tree" for directories and "blob" for files
		if (
			(pathParts[2] === "tree" || pathParts[2] === "blob") &&
			pathParts.length > 3
		) {
			branch = pathParts[3]
			if (pathParts.length > 4) {
				subpath = pathParts.slice(4).join("/")
			}
		}

		return {
			owner,
			repo,
			subpath,
			branch: branch || "main",
		}
	} catch {
		return null
	}
}

/**
 * Extract the raw runToolsSlug from a run.tools subdomain URL.
 * Does NOT attempt to reverse-engineer a qualifiedName — the slug may be
 * customized and the mapping is not reversible.
 *
 * - "https://exa.run.tools" → "exa"
 * - "https://github--anthropic.run.tools" → "github--anthropic"
 * - "https://server.smithery.ai/foo" → null (not a run.tools URL)
 */
export function extractRunToolsSlug(url: string): string | null {
	try {
		const hostname = new URL(url).hostname
		if (!hostname.endsWith(".run.tools")) return null
		const prefix = hostname.slice(0, -".run.tools".length)
		// Only single-level subdomains are valid flat slugs
		if (prefix && !prefix.includes(".")) return prefix
		return null
	} catch {
		return null
	}
}

/**
 * Parse a gateway MCP URL to extract the qualified name (without @ prefix).
 *
 * Always returns the normalized form without `@` prefix, e.g. "namespace/slug".
 * Callers that need to match against DB rows with legacy `@` prefix should
 * check both forms.
 *
 * Supports formats:
 * - Legacy nested subdomain: "https://slug.namespace.run.tools" (deprecated)
 * - Legacy path: "https://server.smithery.ai/@namespace/slug" or with /mcp suffix
 *
 * NOTE: Flat run.tools subdomain URLs (e.g., "https://exa.run.tools") return null
 * because the runToolsSlug may be customized and cannot be reliably reversed to a
 * qualifiedName. Use `extractRunToolsSlug` + a DB lookup by `runToolsSlug` instead.
 *
 * @param url - A gateway MCP URL
 * @returns The qualified name (e.g., "namespace/slug") or null if not parseable
 */
export function parseGatewayMcpUrl(url: string): string | null {
	try {
		const urlObj = new URL(url)

		// run.tools subdomain format
		if (urlObj.hostname.endsWith(".run.tools")) {
			const prefix = urlObj.hostname.slice(0, -".run.tools".length)
			const parts = prefix.split(".")

			// Legacy nested format: slug.namespace.run.tools (deprecated)
			if (parts.length === 2 && parts[0] && parts[1]) {
				return `${parts[1]}/${parts[0]}`
			}

			// Flat run.tools subdomains cannot be reliably reversed to a qualifiedName.
			return null
		}

		// Legacy format (deprecated: remove when server.smithery.ai is sunset)
		if (urlObj.hostname === "server.smithery.ai") {
			return extractQualifiedNameFromPath(urlObj.pathname)
		}

		return null
	} catch {
		return null
	}
}

/** Extract and normalize a qualified name from a URL pathname, stripping @ prefix and /mcp suffix. */
function extractQualifiedNameFromPath(pathname: string) {
	let p = pathname
	if (p.endsWith("/mcp")) {
		p = p.slice(0, -4)
	}
	// Remove leading slash and @ prefix
	let qualifiedName = p.slice(1)
	if (qualifiedName.startsWith("@")) {
		qualifiedName = qualifiedName.slice(1)
	}
	if (!qualifiedName || qualifiedName.length === 0) {
		return null
	}
	return qualifiedName
}
