import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createSession, deleteSession, fetchSessions, type TerminalSession } from "#/lib/api";

const TERMINALS_QUERY_KEY = ["terminals"] as const;

interface DeleteMutationContext {
  previousActiveSessionId: string | null;
  previousSessions: TerminalSession[];
}

export function useTerminalSessions() {
  const queryClient = useQueryClient();
  const autoCreateRequestedRef = useRef(false);
  const pendingCreatedSessionIdRef = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: TERMINALS_QUERY_KEY,
    queryFn: fetchSessions,
    refetchInterval: 5000,
    retry: false,
  });

  const sessions = (sessionsQuery.data ?? []).filter((session) => session.status !== "closed");

  const createMutation = useMutation({
    mutationFn: () => createSession(80, 24),
    onSuccess: (sessionId) => {
      pendingCreatedSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      void queryClient.invalidateQueries({ queryKey: TERMINALS_QUERY_KEY });
    },
  });

  const deleteMutation = useMutation<void, Error, string, DeleteMutationContext>({
    mutationFn: deleteSession,
    onMutate: async (sessionId) => {
      setDeletingSessionId(sessionId);
      await queryClient.cancelQueries({ queryKey: TERMINALS_QUERY_KEY });

      const previousSessions =
        queryClient.getQueryData<TerminalSession[]>(TERMINALS_QUERY_KEY) ?? [];
      const previousActiveSessionId = activeSessionId;
      const nextSessions = previousSessions.filter((session) => session.sessionId !== sessionId);

      queryClient.setQueryData<TerminalSession[]>(TERMINALS_QUERY_KEY, nextSessions);
      setActiveSessionId((current) => {
        if (current !== sessionId) return current;
        return nextSessions[0]?.sessionId ?? null;
      });

      return { previousActiveSessionId, previousSessions };
    },
    onError: (_error, _sessionId, context) => {
      if (!context) return;
      queryClient.setQueryData<TerminalSession[]>(TERMINALS_QUERY_KEY, context.previousSessions);
      setActiveSessionId(context.previousActiveSessionId);
    },
    onSettled: () => {
      setDeletingSessionId(null);
      void queryClient.invalidateQueries({ queryKey: TERMINALS_QUERY_KEY });
    },
  });

  const {
    isError: isCreateError,
    isPending: isCreatingSession,
    mutate: mutateCreateSession,
  } = createMutation;
  const { isPending: isDeletingSession, mutate: mutateDeleteSession } = deleteMutation;

  useEffect(() => {
    if (sessions.length > 0) {
      autoCreateRequestedRef.current = false;
      const hasActiveSession =
        activeSessionId !== null &&
        sessions.some((session) => session.sessionId === activeSessionId);
      if (hasActiveSession) {
        pendingCreatedSessionIdRef.current = null;
        return;
      }
      if (activeSessionId !== null && pendingCreatedSessionIdRef.current === activeSessionId) {
        return;
      }
      if (!activeSessionId || !hasActiveSession) {
        setActiveSessionId(sessions[0].sessionId);
      }
      return;
    }

    if (
      sessionsQuery.isLoading ||
      sessionsQuery.isError ||
      isCreatingSession ||
      isDeletingSession ||
      autoCreateRequestedRef.current
    ) {
      return;
    }

    autoCreateRequestedRef.current = true;
    mutateCreateSession();
  }, [
    activeSessionId,
    isCreatingSession,
    isDeletingSession,
    mutateCreateSession,
    sessions,
    sessionsQuery.isError,
    sessionsQuery.isLoading,
  ]);

  const startSession = () => {
    if (isCreatingSession) return;
    autoCreateRequestedRef.current = true;
    mutateCreateSession();
  };

  const selectSession = (sessionId: string) => {
    pendingCreatedSessionIdRef.current = null;
    setActiveSessionId(sessionId);
  };

  const emptyStateMessage = (() => {
    if (sessionsQuery.isLoading && sessions.length === 0) {
      return "Loading terminals...";
    }
    if (isDeletingSession && sessions.length === 0) {
      return "Closing terminal...";
    }
    if (isCreatingSession && sessions.length === 0) {
      return "Starting terminal...";
    }
    if (isCreateError && sessions.length === 0) {
      return "Couldn't start a terminal. Use + to retry.";
    }
    return null;
  })();

  return {
    activeSessionId,
    createSession: startSession,
    deleteSession: mutateDeleteSession,
    deletingSessionId,
    emptyStateMessage,
    isCreatingSession,
    isError: sessionsQuery.isError,
    isLoadingSessions: sessionsQuery.isLoading,
    sessions,
    selectSession,
  };
}
