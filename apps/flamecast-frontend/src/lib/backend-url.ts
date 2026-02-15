const PROD_BACKEND_URL = "https://api.flamecast.dev"
const DEV_BACKEND_URL = "http://localhost:6970"

export const BACKEND_URL =
	import.meta.env.VITE_BACKEND_URL ||
	(import.meta.env.DEV ? DEV_BACKEND_URL : PROD_BACKEND_URL)
