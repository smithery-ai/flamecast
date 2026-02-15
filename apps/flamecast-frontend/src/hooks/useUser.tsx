import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import {
  getBackendAuthUser,
  redirectToBackendLogin,
  type BackendAuthUser,
} from '@/lib/backend-auth'

export function useAuthSession() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => getBackendAuthUser(),
    retry: false,
  })
}

// Redirects to backend login if there is no authenticated user.
export const useUser = (): BackendAuthUser | null => {
  const location = useLocation()
  const { data: user, isLoading, error } = useAuthSession()

  useEffect(() => {
    if (!isLoading && !error && !user) {
      const fallback = location.pathname
      const returnTo =
        typeof window !== 'undefined' ? window.location.href : fallback
      redirectToBackendLogin(returnTo)
    }
  }, [isLoading, error, user, location.pathname])

  return user ?? null
}
