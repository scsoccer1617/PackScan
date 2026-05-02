# PackScan

## Running locally

- **`npm run dev`** — Vite dev server with HMR. Use this when actively editing client code. Cold-starts are slow on Replit (1–2 min) because Vite transforms files on demand.
- **`npm run dev:fast`** — Builds the production bundle once and serves it from `dist/`. Loads in 1–3s. Use this when you just want to use the app, not edit it. Re-run `npm run dev:fast` after pulling new code to rebuild.
- **`npm start`** — Production mode (`NODE_ENV=production`). Don't use locally; this is for prod deploys.
