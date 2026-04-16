# Flamecast

![Flamecast demo](demo.gif)

> **Early alpha** — APIs and features may change without notice.

Flamecast lets you access your computer from anywhere through a web browser.

## Quick start

```bash
npx flamecast@latest up
```

Then open [flamecast-frontend.vercel.app](https://flamecast-frontend.vercel.app) in your browser to pick your session and interact with the terminal.

`flamecast up` stays attached to your terminal. Press `Ctrl+C` to stop it, or run `npx flamecast down` from another shell.

## How it works

Flamecast runs a lightweight agent on your machine and connects it to a web UI through a relay. The relay only brokers the connection — **your data stays on your machine** and is never stored or inspected by Flamecast servers. The entire stack is open-source and can run fully on your own infrastructure if you prefer.
