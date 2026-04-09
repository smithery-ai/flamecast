import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";
import type { QueuedMessage } from "@flamecast/protocol/storage";

export function useMessageQueue() {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["message-queue"],
    queryFn: () => client.listMessageQueue(),
    refetchInterval: 5_000,
  });
}

export function useEnqueueMessage(options?: {
  onSuccess?: (msg: QueuedMessage) => void;
  onError?: (err: Error) => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: Omit<QueuedMessage, "id" | "createdAt" | "sentAt" | "status">) =>
      client.enqueueMessage(message),
    onSuccess: (msg) => {
      void queryClient.invalidateQueries({ queryKey: ["message-queue"] });
      options?.onSuccess?.(msg);
    },
    onError: options?.onError,
  });
}

export function useSendQueuedMessage(options?: {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => client.sendQueuedMessage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["message-queue"] });
      options?.onSuccess?.();
    },
    onError: options?.onError,
  });
}

export function useRemoveQueuedMessage(options?: { onError?: (err: Error) => void }) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => client.removeQueuedMessage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["message-queue"] });
    },
    onError: options?.onError,
  });
}

export function useClearMessageQueue(options?: { onError?: (err: Error) => void }) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.clearMessageQueue(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["message-queue"] });
    },
    onError: options?.onError,
  });
}
