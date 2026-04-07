import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";
import { useFlamecastClient } from "../provider.js";

export function useStartRuntime(options?: {
  onSuccess?: (instance: RuntimeInstance) => void;
  onError?: (err: Error, vars: { typeName: string; name?: string }) => void;
  onMutate?: (vars: { typeName: string; name?: string }) => void;
  onSettled?: () => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ typeName, name }: { typeName: string; name?: string }) =>
      client.startRuntime(typeName, name),
    onMutate: options?.onMutate,
    onSuccess: (instance) => {
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      options?.onSuccess?.(instance);
    },
    onError: options?.onError
      ? (err: Error, vars: { typeName: string; name?: string }) => options.onError?.(err, vars)
      : undefined,
    onSettled: options?.onSettled,
  });
}

export function useStopRuntime(options?: {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
  onMutate?: (name: string) => void;
  onSettled?: () => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => client.stopRuntime(name),
    onMutate: options?.onMutate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      options?.onSuccess?.();
    },
    onError: options?.onError,
    onSettled: options?.onSettled,
  });
}

export function usePauseRuntime(options?: {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
  onMutate?: (name: string) => void;
  onSettled?: () => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => client.pauseRuntime(name),
    onMutate: options?.onMutate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      options?.onSuccess?.();
    },
    onError: options?.onError,
    onSettled: options?.onSettled,
  });
}

export function useDeleteRuntime(options?: {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
  onMutate?: (name: string) => void;
  onSettled?: () => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => client.deleteRuntime(name),
    onMutate: (name) => {
      options?.onMutate?.(name);
    },
    onSuccess: (_data, name) => {
      // Optimistically remove the instance from the cache before refetch
      queryClient.setQueryData<RuntimeInfo[] | undefined>(["runtimes"], (current) =>
        current
          ?.map((rt) => ({
            ...rt,
            instances: rt.instances.filter((i) => i.name !== name),
          }))
          .filter((rt) => rt.instances.length > 0 || rt.onlyOne),
      );
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      options?.onSuccess?.();
    },
    onError: options?.onError,
    onSettled: options?.onSettled,
  });
}

export function useStartRuntimeWithOptimisticUpdate(
  runtimeInfo: RuntimeInfo,
  options?: {
    instanceName?: string;
    onSuccess?: (instance: RuntimeInstance) => void;
    onError?: (err: Error, name?: string) => void;
    onSettled?: () => void;
  },
) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      client.startRuntime(
        runtimeInfo.typeName,
        runtimeInfo.onlyOne ? undefined : options?.instanceName,
      ),
    onSuccess: (startedInstance) => {
      queryClient.setQueryData<RuntimeInfo[] | undefined>(["runtimes"], (current) =>
        current?.map((rt) => {
          if (rt.typeName !== runtimeInfo.typeName) return rt;
          const existing = rt.instances.find((i) => i.name === startedInstance.name);
          return {
            ...rt,
            instances: existing
              ? rt.instances.map((i) => (i.name === startedInstance.name ? startedInstance : i))
              : [...rt.instances, startedInstance],
          };
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      void queryClient.invalidateQueries({
        queryKey: ["runtime-filesystem", options?.instanceName ?? runtimeInfo.typeName],
      });
      options?.onSuccess?.(startedInstance);
    },
    onError: options?.onError
      ? (err: Error) => options.onError?.(err, options?.instanceName)
      : undefined,
    onSettled: options?.onSettled,
  });
}
