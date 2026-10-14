# Local preview

Open http://127.0.0.1:4311/local-preview to begin a temporary Local Host session. Create rooms and try chat, tasks and reports. No AI agents are connected. Cloud attachments are deliberately unavailable.

The Node HTTP server listens only on 127.0.0.1. Redis uses a separate private Unix socket, a 128 MiB memory cap, and no disk persistence. Preview data is discarded when the preview stops. Do not use real project secrets in this temporary environment.

Runtime: Node 24 (the local loader uses its TypeScript transform support). With Node 24 selected, `npm run preview:local` starts the already-built preview. Stop with Ctrl-C in its terminal. Build updates with `npm run build:ordered` after reviewing the build scripts; the preview serves apps/web/dist and requires a browser reload after rebuilding.

Security dependency update: Vite 8, Vitest 5, React Router 7, MCP SDK 1.32.1, Tailwind 4. Removed the unused Clerk package and Vercel runtime dependency (only HTTP types were needed), and removed external analytics/fonts from the web entry point. Dependency lifecycle scripts were disabled during installation.

Validation on 2026-10-14: npm audit reports zero known vulnerabilities. Shared/storage/persistence/web TypeScript checks and the Vite production build passed. 31 focused security regression tests and 213 selected compatibility tests passed. Real local Redis HTTP checks passed for session, create/join, send/read message, report, end room, anonymous rejection and cross-origin rejection. The new-meeting page was visually verified in the browser.

This does not certify the separate Codex connector, cloud bucket configuration, every upstream test or production deployment. The automatic installer and outbound webhooks remain disabled. Staging and Codex configuration were not changed.
