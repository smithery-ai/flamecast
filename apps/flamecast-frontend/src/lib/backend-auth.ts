const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || 'https://api.flamecast.dev'

export interface BackendAuthUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  profilePictureUrl: string | null
}

function authUrl(pathname: string) {
  return new URL(pathname, BACKEND_URL)
}

function resolveReturnTo(returnTo?: string) {
  if (returnTo) return returnTo
  if (typeof window !== 'undefined') return window.location.href
  return undefined
}

function getAppOrigin() {
  if (typeof window === 'undefined') return undefined
  return window.location.origin
}

export async function getBackendAuthUser(): Promise<BackendAuthUser | null> {
  const res = await fetch(authUrl('/auth/me').toString(), {
    credentials: 'include',
    cache: 'no-store',
  })

  if (res.status === 401) return null

  if (!res.ok) {
    throw new Error(`Auth request failed (${res.status})`)
  }

  const body = (await res.json()) as { user?: BackendAuthUser }
  return body.user ?? null
}

export function getBackendLoginUrl(returnTo?: string) {
  const url = authUrl('/auth/login')
  const resolvedReturnTo = resolveReturnTo(returnTo)
  if (resolvedReturnTo) url.searchParams.set('returnTo', resolvedReturnTo)

  const appOrigin = getAppOrigin()
  if (appOrigin) url.searchParams.set('appOrigin', appOrigin)

  return url.toString()
}

export function redirectToBackendLogin(returnTo?: string) {
  if (typeof window === 'undefined') return
  window.location.assign(getBackendLoginUrl(returnTo))
}

export function getBackendLogoutUrl(returnTo?: string) {
  const url = authUrl('/auth/logout')
  const resolvedReturnTo = resolveReturnTo(returnTo)
  if (resolvedReturnTo) url.searchParams.set('returnTo', resolvedReturnTo)

  const appOrigin = getAppOrigin()
  if (appOrigin) url.searchParams.set('appOrigin', appOrigin)

  return url.toString()
}

export function redirectToBackendLogout(returnTo?: string) {
  if (typeof window === 'undefined') return
  window.location.assign(getBackendLogoutUrl(returnTo))
}
