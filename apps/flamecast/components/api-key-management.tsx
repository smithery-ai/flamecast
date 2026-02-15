"use client"

import { useState, useEffect, useCallback } from "react"
import posthog from "posthog-js"
import { listApiKeys, createApiKey, deleteApiKey } from "@/lib/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { PlusIcon, Trash2Icon, CopyIcon, CheckIcon } from "lucide-react"
import { toast } from "sonner"

interface ApiKey {
	id: string
	name: string | null
	description: string | null
	createdAt: string
}

export function ApiKeyManagement() {
	const [keys, setKeys] = useState<ApiKey[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const fetchKeys = useCallback(async () => {
		try {
			const data = await listApiKeys()
			setKeys(data.keys)
			setError(null)
		} catch {
			setError("Failed to load API keys")
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		fetchKeys()
	}, [fetchKeys])

	async function handleDelete(id: string) {
		try {
			await deleteApiKey(id)
			setKeys(prev => prev.filter(k => k.id !== id))
			toast.success("API key deleted")
			posthog.capture("api_key_deleted")
		} catch (e) {
			toast.error("Failed to delete API key")
			posthog.captureException(e)
		}
	}

	if (loading) {
		return (
			<p className="text-zinc-500 dark:text-zinc-400">Loading API keys...</p>
		)
	}

	return (
		<section className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<div className="flex flex-col gap-1">
					<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
						API Keys
					</h2>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						Manage API keys for programmatic access.
					</p>
				</div>
				<CreateKeyDialog onCreated={fetchKeys} />
			</div>

			{error && <p className="text-sm text-red-500">{error}</p>}

			{keys.length === 0 ? (
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					No API keys yet. Create one to get started.
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{keys.map(key => (
						<div
							key={key.id}
							className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-3"
						>
							<div className="flex flex-col gap-0.5">
								<span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
									{key.name || "Unnamed key"}
								</span>
								{key.description && (
									<span className="text-xs text-zinc-500 dark:text-zinc-400">
										{key.description}
									</span>
								)}
								<span className="text-xs text-zinc-400 dark:text-zinc-500">
									Created {new Date(key.createdAt).toLocaleDateString()}
								</span>
							</div>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="text-zinc-400 hover:text-red-500"
									>
										<Trash2Icon className="h-4 w-4" />
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Delete API key</AlertDialogTitle>
										<AlertDialogDescription>
											This will permanently delete the API key
											{key.name ? ` "${key.name}"` : ""}. Any applications using
											this key will stop working. This action cannot be undone.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											onClick={() => handleDelete(key.id)}
											className="bg-red-600 hover:bg-red-700"
										>
											Delete
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
					))}
				</div>
			)}
		</section>
	)
}

function CreateKeyDialog({ onCreated }: { onCreated: () => void }) {
	const [open, setOpen] = useState(false)
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [creating, setCreating] = useState(false)
	const [createdKey, setCreatedKey] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	function resetForm() {
		setName("")
		setDescription("")
		setCreating(false)
		setCreatedKey(null)
		setCopied(false)
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			if (createdKey) onCreated()
			resetForm()
		}
		setOpen(nextOpen)
	}

	async function handleCreate() {
		setCreating(true)
		try {
			const data = await createApiKey(name, description)
			setCreatedKey(data.key)
			posthog.capture("api_key_created", {
				has_name: !!name.trim(),
				has_description: !!description.trim(),
			})
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create API key")
			posthog.captureException(e)
			setCreating(false)
		}
	}

	async function handleCopy() {
		if (!createdKey) return
		await navigator.clipboard.writeText(createdKey)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button size="sm">
					<PlusIcon className="h-4 w-4 mr-1" />
					Create API Key
				</Button>
			</DialogTrigger>
			<DialogContent>
				{createdKey ? (
					<>
						<DialogHeader>
							<DialogTitle>API key created</DialogTitle>
							<DialogDescription>
								Copy your API key now. You won't be able to see it again.
							</DialogDescription>
						</DialogHeader>
						<div className="flex items-center gap-2">
							<code className="flex-1 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm font-mono break-all">
								{createdKey}
							</code>
							<Button variant="outline" size="icon" onClick={handleCopy}>
								{copied ? (
									<CheckIcon className="h-4 w-4 text-green-500" />
								) : (
									<CopyIcon className="h-4 w-4" />
								)}
							</Button>
						</div>
						<DialogFooter>
							<Button onClick={() => handleOpenChange(false)}>Done</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Create API key</DialogTitle>
							<DialogDescription>
								Give your API key a name and optional description.
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="key-name">Name</Label>
								<Input
									id="key-name"
									placeholder="e.g. Production, CI/CD"
									value={name}
									onChange={e => setName(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="key-description">
									Description{" "}
									<span className="text-zinc-400 font-normal">(optional)</span>
								</Label>
								<Textarea
									id="key-description"
									placeholder="What is this key used for?"
									value={description}
									onChange={e => setDescription(e.target.value)}
									rows={2}
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								onClick={handleCreate}
								disabled={creating || !name.trim()}
							>
								{creating ? "Creating..." : "Create"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
