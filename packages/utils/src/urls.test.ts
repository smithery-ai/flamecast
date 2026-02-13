import { describe, it, expect } from "vitest"
import {
	parseQualifiedName,
	toSubdomainUrl,
	computeDefaultRunToolsSlug,
	toRunToolsUrl,
	getLegacyGatewayMcpUrl,
	extractRunToolsSlug,
	parseGatewayMcpUrl,
} from "./urls.js"

describe("parseQualifiedName", () => {
	it("parses single-part name", () => {
		expect(parseQualifiedName("exa")).toEqual({ namespace: "exa", slug: "" })
	})

	it("parses namespace/slug", () => {
		expect(parseQualifiedName("anthropic/github")).toEqual({
			namespace: "anthropic",
			slug: "github",
		})
	})

	it("strips @ prefix", () => {
		expect(parseQualifiedName("@anthropic/github")).toEqual({
			namespace: "anthropic",
			slug: "github",
		})
	})

	it("lowercases everything", () => {
		expect(parseQualifiedName("Anthropic/GitHub")).toEqual({
			namespace: "anthropic",
			slug: "github",
		})
	})
})

describe("toSubdomainUrl", () => {
	it("simple name → namespace.run.tools", () => {
		expect(toSubdomainUrl("exa")).toBe("https://exa.run.tools")
	})

	it("namespace/slug → slug.namespace.run.tools", () => {
		expect(toSubdomainUrl("anthropic/github")).toBe(
			"https://github.anthropic.run.tools",
		)
	})

	it("strips @ prefix", () => {
		expect(toSubdomainUrl("@anthropic/github")).toBe(
			"https://github.anthropic.run.tools",
		)
	})

	it("uses custom domain when provided", () => {
		expect(toSubdomainUrl("exa", "mcp.exa.ai")).toBe("https://mcp.exa.ai")
	})
})

describe("computeDefaultRunToolsSlug", () => {
	it("namespace-only → namespace", () => {
		expect(computeDefaultRunToolsSlug("exa")).toBe("exa")
	})

	it("namespace/slug → slug--namespace", () => {
		expect(computeDefaultRunToolsSlug("anthropic/github")).toBe(
			"github--anthropic",
		)
	})

	it("strips @ prefix", () => {
		expect(computeDefaultRunToolsSlug("@anthropic/github")).toBe(
			"github--anthropic",
		)
	})

	it("lowercases", () => {
		expect(computeDefaultRunToolsSlug("Anthropic/GitHub")).toBe(
			"github--anthropic",
		)
	})
})

describe("toRunToolsUrl", () => {
	it("builds flat subdomain URL", () => {
		expect(toRunToolsUrl("exa")).toBe("https://exa.run.tools")
	})

	it("builds flat subdomain URL with double-dash slug", () => {
		expect(toRunToolsUrl("github--anthropic")).toBe(
			"https://github--anthropic.run.tools",
		)
	})

	it("uses custom domain when provided", () => {
		expect(toRunToolsUrl("exa", "mcp.exa.ai")).toBe("https://mcp.exa.ai")
	})
})

describe("getLegacyGatewayMcpUrl", () => {
	it("returns server.smithery.ai format for namespace-only", () => {
		expect(getLegacyGatewayMcpUrl("exa")).toBe("https://server.smithery.ai/exa")
	})

	it("returns server.smithery.ai format for namespace/slug", () => {
		expect(getLegacyGatewayMcpUrl("anthropic/github")).toBe(
			"https://server.smithery.ai/anthropic/github",
		)
	})
})

describe("extractRunToolsSlug", () => {
	it("extracts slug from flat run.tools subdomain", () => {
		expect(extractRunToolsSlug("https://exa.run.tools")).toBe("exa")
	})

	it("extracts slug with double-dash separator", () => {
		expect(extractRunToolsSlug("https://github--anthropic.run.tools")).toBe(
			"github--anthropic",
		)
	})

	it("returns null for nested subdomains", () => {
		expect(extractRunToolsSlug("https://slug.namespace.run.tools")).toBe(null)
	})

	it("returns null for bare run.tools", () => {
		expect(extractRunToolsSlug("https://run.tools")).toBe(null)
	})

	it("returns null for non-run.tools domains", () => {
		expect(extractRunToolsSlug("https://server.smithery.ai/exa")).toBe(null)
	})

	it("returns null for invalid URLs", () => {
		expect(extractRunToolsSlug("not-a-url")).toBe(null)
	})
})

describe("parseGatewayMcpUrl", () => {
	it("returns null for flat run.tools subdomain (not reversible)", () => {
		expect(parseGatewayMcpUrl("https://exa.run.tools")).toBe(null)
	})

	it("returns null for flat run.tools with double-dash (not reversible)", () => {
		expect(parseGatewayMcpUrl("https://github--anthropic.run.tools")).toBe(null)
	})

	it("parses legacy nested run.tools subdomain (slug.namespace)", () => {
		expect(parseGatewayMcpUrl("https://github.anthropic.run.tools")).toBe(
			"anthropic/github",
		)
	})

	it("returns null for bare run.tools", () => {
		expect(parseGatewayMcpUrl("https://run.tools")).toBe(null)
		expect(parseGatewayMcpUrl("https://run.tools/exa")).toBe(null)
		expect(parseGatewayMcpUrl("https://run.tools/anthropic/github")).toBe(null)
	})

	it("parses legacy server.smithery.ai format", () => {
		expect(
			parseGatewayMcpUrl("https://server.smithery.ai/@smithery/unicorn"),
		).toBe("smithery/unicorn")
	})

	it("strips /mcp suffix from legacy format", () => {
		expect(
			parseGatewayMcpUrl("https://server.smithery.ai/@smithery/unicorn/mcp"),
		).toBe("smithery/unicorn")
	})

	it("strips @ prefix from legacy format", () => {
		expect(parseGatewayMcpUrl("https://server.smithery.ai/@exa")).toBe("exa")
	})

	it("returns null for unknown domains", () => {
		expect(parseGatewayMcpUrl("https://example.com/foo")).toBe(null)
	})

	it("returns null for invalid URLs", () => {
		expect(parseGatewayMcpUrl("not-a-url")).toBe(null)
	})

	it("returns null for empty path on legacy format", () => {
		expect(parseGatewayMcpUrl("https://server.smithery.ai/")).toBe(null)
	})
})
