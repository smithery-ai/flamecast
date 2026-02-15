import { PostHog } from "posthog-node"

export function createPostHogClient(apiKey: string, host?: string) {
	return new PostHog(apiKey, {
		host,
		flushAt: 1,
		flushInterval: 0,
	})
}
