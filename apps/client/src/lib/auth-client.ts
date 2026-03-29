import { createAuthClient } from "better-auth/react";

// VITE_API_URL is e.g. "http://localhost:3001/api" or "https://example.com/api".
// better-auth expects the server origin (it appends /api/auth/* itself).
/** @type {string | undefined} */
const apiUrl: string | undefined = import.meta.env.VITE_API_URL;
const baseURL = apiUrl ? apiUrl.replace(/\/api\/?$/, "") : undefined;

const authClient = createAuthClient({ baseURL });

export const { useSession, signIn, signOut } = authClient;
