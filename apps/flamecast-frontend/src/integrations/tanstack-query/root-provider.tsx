import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

export function getContext() {
  return {
    queryClient,
  }
}

export default function TanStackQueryProvider({
  children,
}: {
  children: ReactNode
}) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
