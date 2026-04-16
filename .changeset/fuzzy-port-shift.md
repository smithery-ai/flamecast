---
"flamecast": minor
---

Change the default port for `flamecast up` from `3000` to `6769` and point users to `https://flamecast-frontend.vercel.app` in the startup message. The hosted frontend now shows an actionable message prompting users to run `npx flamecast@latest up` when it can't reach a local instance.
