import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  Activity,
  Blocks,
  CircleAlert,
  LoaderCircle,
  Power,
  RefreshCcw,
  Send,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  FlamecastApiError,
  closeSession,
  createSession,
  flamecastBaseUrl,
  runCommand,
  sendInput,
  sessionDetailsQueryOptions,
  sessionsQueryOptions,
} from '@/lib/flamecast-api'

export const Route = createFileRoute('/')({ component: App })

type Tone = 'default' | 'destructive' | 'outline' | 'secondary'

function formatWhen(value: string) {
  return new Date(value).toLocaleString()
}

function parseOptionalNumber(value: string) {
  if (!value.trim()) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseKeys(value: string) {
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return keys.length > 0 ? keys : undefined
}

function statusVariant(status: string): Tone {
  if (status === 'running') {
    return 'secondary'
  }

  if (status === 'exited' || status === 'expired') {
    return 'outline'
  }

  return 'destructive'
}

function errorMessage(error: Error | null) {
  if (!error) {
    return null
  }

  if (error instanceof FlamecastApiError) {
    return error.message
  }

  return 'The request failed before the response could be parsed.'
}

function App() {
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery(sessionsQueryOptions)
  const sessions = sessionsQuery.data?.sessions ?? []

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')
  const [shell, setShell] = useState('')
  const [createTimeout, setCreateTimeout] = useState('300')
  const [command, setCommand] = useState('pwd')
  const [commandTimeout, setCommandTimeout] = useState('30')
  const [inputText, setInputText] = useState('')
  const [inputKeys, setInputKeys] = useState('enter')

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null)
      }
      return
    }

    if (selectedSessionId && sessions.some((session) => session.sessionId === selectedSessionId)) {
      return
    }

    setSelectedSessionId(sessions[0].sessionId)
  }, [selectedSessionId, sessions])

  const detailQuery = useQuery({
    ...sessionDetailsQueryOptions(selectedSessionId ?? 'pending'),
    enabled: selectedSessionId !== null,
  })

  const createMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      setSelectedSessionId(data.sessionId)
      setCwd('')
      setShell('')
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const runCommandMutation = useMutation({
    mutationFn: runCommand,
    onSuccess: (data) => {
      setSelectedSessionId(data.sessionId)
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void queryClient.invalidateQueries({ queryKey: ['sessions', data.sessionId] })
    },
  })

  const sendInputMutation = useMutation({
    mutationFn: sendInput,
    onSuccess: (_, variables) => {
      setInputText('')
      void queryClient.invalidateQueries({ queryKey: ['sessions', variables.sessionId] })
    },
  })

  const closeMutation = useMutation({
    mutationFn: closeSession,
    onSuccess: (data) => {
      if (selectedSessionId === data.sessionId) {
        setSelectedSessionId(null)
      }
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const detail = detailQuery.data
  const runningCount = sessions.filter((session) => session.status === 'running').length

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-6">
      <section className='flex flex-col gap-6'>
        <div className="space-y-4">
          <Badge variant="outline">shadcn ui + tanstack query + hono rpc</Badge>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
              Flamecast control surface
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
              This client talks directly to `packages/flamecast` through typed
              Hono RPC and every request path is rendered with explicit loading,
              empty, success, or error states.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                void sessionsQuery.refetch()
                if (selectedSessionId) {
                  void detailQuery.refetch()
                }
              }}
            >
              <RefreshCcw className="size-4" />
              Refresh state
            </Button>
            <Button asChild variant="outline">
              <Link to="/about">About</Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
   
          <MetricCard
            icon={Blocks}
            label="Sessions"
            value={String(sessions.length)}
            caption="Live sessions tracked over RPC"
          />
          <MetricCard
            icon={Activity}
            label="Running"
            value={String(runningCount)}
            caption="Auto-refreshed every five seconds"
          />
          <MetricCard
            icon={Terminal}
            label="API origin"
            value={flamecastBaseUrl}
            caption="Override with VITE_FLAMECAST_API_ORIGIN"
            mono
          />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Create a session</CardTitle>
              <CardDescription>
                Blank fields fall back to the server defaults.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Working directory">
                <Input
                  placeholder="/Users/anirudh/Documents/GitHub/flamecast"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                />
              </Field>
              <Field label="Shell">
                <Input
                  placeholder="/bin/zsh"
                  value={shell}
                  onChange={(event) => setShell(event.target.value)}
                />
              </Field>
              <Field label="Timeout in seconds">
                <Input
                  inputMode="numeric"
                  placeholder="300"
                  value={createTimeout}
                  onChange={(event) => setCreateTimeout(event.target.value)}
                />
              </Field>

              <Button
                onClick={() => {
                  void createMutation.mutate({
                    cwd: cwd.trim() || undefined,
                    shell: shell.trim() || undefined,
                    timeout: parseOptionalNumber(createTimeout),
                  })
                }}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    Creating session
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    New session
                  </>
                )}
              </Button>

              {createMutation.error ? (
                <InlineError
                  title="Could not create a session"
                  description={errorMessage(createMutation.error)}
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>Sessions</CardTitle>
                <CardDescription>
                  Select a session to inspect output, send input, or close it.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void sessionsQuery.refetch()
                }}
              >
                <RefreshCcw className="size-4" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {sessionsQuery.isPending ? (
                <div className="grid gap-3">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </div>
              ) : null}

              {sessionsQuery.isError ? (
                <InlineError
                  title="Could not load sessions"
                  description={errorMessage(sessionsQuery.error)}
                />
              ) : null}

              {!sessionsQuery.isPending &&
              !sessionsQuery.isError &&
              sessions.length === 0 ? (
                <Alert>
                  <AlertTitle>No sessions yet</AlertTitle>
                  <AlertDescription>
                    Create a new tmux-backed session or run a command to let
                    the server auto-create one.
                  </AlertDescription>
                </Alert>
              ) : null}

              {!sessionsQuery.isPending && !sessionsQuery.isError && sessions.length > 0 ? (
                <div className="grid gap-3">
                  {sessions.map((session) => (
                    <button
                      key={session.sessionId}
                      type="button"
                      className="rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent"
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{session.sessionId}</span>
                            <Badge
                              variant={
                                selectedSessionId === session.sessionId
                                  ? 'default'
                                  : statusVariant(session.status)
                              }
                            >
                              {session.status}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground text-sm">{session.cwd}</p>
                        </div>
                        <div className="text-muted-foreground text-right text-xs">
                          <div>{session.shell}</div>
                          <div>Updated {formatWhen(session.lastActivity)}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>Session detail</CardTitle>
                <CardDescription>
                  Typed `GET /api/sessions/:id` output with live status and
                  terminal buffer.
                </CardDescription>
              </div>
              {selectedSessionId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void detailQuery.refetch()
                  }}
                >
                  <RefreshCcw className="size-4" />
                  Refresh
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="grid gap-4">
              {!selectedSessionId ? (
                <Alert>
                  <AlertTitle>Select a session</AlertTitle>
                  <AlertDescription>
                    The detail pane will populate once a session exists.
                  </AlertDescription>
                </Alert>
              ) : null}

              {selectedSessionId && detailQuery.isPending ? (
                <div className="grid gap-3">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-72" />
                </div>
              ) : null}

              {selectedSessionId && detailQuery.isError ? (
                <InlineError
                  title="Could not load the selected session"
                  description={errorMessage(detailQuery.error)}
                />
              ) : null}

              {detail ? (
                <>
                  <div className="grid gap-3 md:grid-cols-3">
                    <DetailStat
                      label="Session"
                      value={detail.sessionId}
                      variant="outline"
                    />
                    <DetailStat
                      label="Status"
                      value={detail.status}
                      variant={statusVariant(detail.status)}
                    />
                    <DetailStat
                      label="Exit code"
                      value={detail.exitCode === null ? 'pending' : String(detail.exitCode)}
                      variant={detail.exitCode === 0 ? 'secondary' : 'outline'}
                    />
                  </div>

                  <div className="grid gap-2 rounded-lg border bg-muted/50 p-4 text-sm">
                    <span className="font-medium">Session metadata</span>
                    <div className="grid gap-1 text-muted-foreground">
                      <span>cwd: {detail.cwd}</span>
                      <span>stream: {detail.streamUrl}</span>
                      <span>line count: {detail.lineCount}</span>
                      <span>byte offset: {detail.byteOffset}</span>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">Terminal output</span>
                      <Badge variant="outline">{detail.output.length} chars</Badge>
                    </div>
                    <ScrollArea className="h-80 rounded-md border bg-muted/50 p-4">
                      <pre className="text-xs leading-6 whitespace-pre-wrap">
                        {detail.output || 'No output captured yet.'}
                      </pre>
                    </ScrollArea>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run a command</CardTitle>
              <CardDescription>
                Uses the selected session when possible and auto-creates one
                otherwise through typed RPC.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Command">
                <Textarea
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="Timeout in seconds" className="sm:max-w-48">
                <Input
                  inputMode="numeric"
                  value={commandTimeout}
                  onChange={(event) => setCommandTimeout(event.target.value)}
                />
              </Field>

              <Button
                disabled={runCommandMutation.isPending || !command.trim()}
                onClick={() => {
                  void runCommandMutation.mutate({
                    command: command.trim(),
                    sessionId: selectedSessionId,
                    timeout: parseOptionalNumber(commandTimeout),
                  })
                }}
              >
                {runCommandMutation.isPending ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    Running command
                  </>
                ) : (
                  <>
                    <Terminal className="size-4" />
                    Execute
                  </>
                )}
              </Button>

              {runCommandMutation.error ? (
                <InlineError
                  title="Command execution failed"
                  description={errorMessage(runCommandMutation.error)}
                />
              ) : null}

              {runCommandMutation.data ? (
                <div className="grid gap-3 rounded-lg border bg-muted/50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">Command result</span>
                    <Badge
                      variant={
                        runCommandMutation.data.exitCode === 0 ? 'secondary' : 'outline'
                      }
                    >
                      exit {runCommandMutation.data.exitCode ?? 'pending'}
                    </Badge>
                  </div>
                  <ScrollArea className="h-48 rounded-md border bg-muted p-4">
                    <pre className="text-xs leading-6 whitespace-pre-wrap">
                      {runCommandMutation.data.output || 'Command returned no output.'}
                    </pre>
                  </ScrollArea>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Send input or close</CardTitle>
              <CardDescription>
                Manual keystrokes stay behind query mutations too.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Text input">
                <Textarea
                  placeholder="npm test"
                  value={inputText}
                  onChange={(event) => setInputText(event.target.value)}
                />
              </Field>
              <Field label="Keys">
                <Input
                  placeholder="enter, ctrl-c"
                  value={inputKeys}
                  onChange={(event) => setInputKeys(event.target.value)}
                />
              </Field>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  disabled={
                    sendInputMutation.isPending ||
                    !selectedSessionId ||
                    (!inputText.trim() && !parseKeys(inputKeys))
                  }
                  onClick={() => {
                    if (!selectedSessionId) {
                      return
                    }

                    void sendInputMutation.mutate({
                      keys: parseKeys(inputKeys),
                      sessionId: selectedSessionId,
                      text: inputText.trim() || undefined,
                    })
                  }}
                >
                  {sendInputMutation.isPending ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      Sending input
                    </>
                  ) : (
                    <>
                      <Send className="size-4" />
                      Send input
                    </>
                  )}
                </Button>

                <Button
                  variant="destructive"
                  disabled={closeMutation.isPending || !selectedSessionId}
                  onClick={() => {
                    if (!selectedSessionId) {
                      return
                    }

                    void closeMutation.mutate(selectedSessionId)
                  }}
                >
                  {closeMutation.isPending ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      Closing
                    </>
                  ) : (
                    <>
                      <Power className="size-4" />
                      Close session
                    </>
                  )}
                </Button>
              </div>

              {sendInputMutation.error ? (
                <InlineError
                  title="Could not send input"
                  description={errorMessage(sendInputMutation.error)}
                />
              ) : null}

              {closeMutation.error ? (
                <InlineError
                  title="Could not close the session"
                  description={errorMessage(closeMutation.error)}
                />
              ) : null}

              {sendInputMutation.data ? (
                <Alert>
                  <AlertTitle>Input accepted</AlertTitle>
                  <AlertDescription>
                    The server accepted input for {sendInputMutation.data.sessionId}.
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  caption,
  mono = false,
}: {
  caption: string
  icon: typeof Activity
  label: string
  mono?: boolean
  value: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        <div className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs uppercase tracking-[0.2em]">
            {label}
          </p>
          <p
            className={mono ? 'truncate font-mono text-sm font-medium' : 'text-3xl font-semibold'}
          >
            {value}
          </p>
          <p className="text-muted-foreground text-sm">{caption}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function DetailStat({
  label,
  value,
  variant,
}: {
  label: string
  value: string
  variant: Tone
}) {
  return (
    <div className="rounded-lg border bg-muted/50 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs uppercase tracking-[0.2em]">
          {label}
        </span>
        <Badge variant={variant}>{value}</Badge>
      </div>
      <Separator />
      <p className="mt-3 text-sm font-medium">{value}</p>
    </div>
  )
}

function Field({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string
  label: string
}) {
  return (
    <div className={className ? `grid gap-2 ${className}` : 'grid gap-2'}>
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  )
}

function InlineError({
  title,
  description,
}: {
  description: string | null
  title: string
}) {
  return (
    <Alert variant="destructive">
      <CircleAlert className="size-4" />
      <div className="grid gap-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </div>
    </Alert>
  )
}
