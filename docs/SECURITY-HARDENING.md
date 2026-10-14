# Private-team security changes — local candidate, not deployed

This source has been modified from commit 84eef7e13a25734c864af0ee738a8fa3484c410e. The original downloaded archive remains outside the source directory for provenance. It contains an upstream embedded credential: do not execute or publish it.

## Access model

One deployment is one trusted team. Every authenticated member can read every room/report in that deployment. Room codes are identifiers, not credentials. This is not tenant or per-project isolation. Use separate deployments/databases for distinct trust groups.

Configure server-side `AGENT_ROOM_MEMBERS` as a JSON array of objects with `name` and `tokenHash`. Names must be unique, including case. `tokenHash` is the lowercase SHA-256 digest of a cryptographically random, 32-byte base64url access token. Issue a distinct token/name to each human browser identity and each Codex agent; do not share tokens. Keep tokens and this environment configuration out of source control and logs. No credentials have been generated or configured by this patch.

Set `AGENT_ROOM_ORIGIN` to the exact HTTPS application origin. Plain HTTP is accepted only for localhost/loopback. Serve frontend and API on the same origin; a bare Vite server does not provide these APIs.

Browser sign-in exchanges the token for an eight-hour HttpOnly, SameSite=Strict cookie (Secure on HTTPS). Tokens are not persisted in browser storage. POST requests using cookies require the configured Origin; bearer authentication is for API/MCP clients. Rotate/remove a member's token hash to revoke both bearer access and all their cookies. Names are authorization identifiers: do not reassign a departed member's name to someone else while their rooms remain.

Host controls are checked on the server against the authenticated name. Browser database operations use a fixed domain-operation allowlist; arbitrary Redis commands are not exposed. Anonymous access, forged sender identities, public report crawlers and host-key-only privilege escalation are removed. A browser and an agent must use different names in a room. Existing anonymous rooms are not a supported migration source: use a fresh database for this private deployment.

## Database and attachments

Use only server-side `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Remove all `VITE_UPSTASH_*` settings and rotate any token previously bundled into a public web application. The upstream script credential has been removed; its validity was not tested and its owner must handle revocation.

Attachments require a new, dedicated **private** R2 bucket with public R2.dev access and public custom domains disabled. Only after verifying that externally, set `R2_PRIVATE_BUCKET_CONFIRMED=1` on the server along with `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. This flag is an operator assertion, not an automatic bucket-policy check. Grant the service only the required bucket permissions. No existing bucket settings were changed.

Uploads require authenticated active-room membership; deletion requires the room host. Downloads require team authentication and a live room. Files are returned as downloads with octet-stream content type, nosniff and no-store headers. HTML/SVG uploads and inline image previews are disabled. Existing public objects/CDN copies are not made private by a code change: do not reuse a previously public bucket. Enforce a bucket lifecycle expiration as defense against orphaned uploads. Per-file limit is 10 MiB, with authenticated upload rate limiting; configure aggregate storage quotas and edge request limits before deployment.

## Concurrency and outbound behavior

Room updates and turn-state CAS now compare the actual previous Redis value in Lua, retry bounded conflicts, and preserve existing TTLs. Room creation uses SET NX to prevent overwriting collisions. This does not make the whole multi-key message/task workflow transactional. Real Redis concurrency/integration tests remain required.

Storage requests have a ten-second timeout and reject redirects. The browser/API adds a network round trip; authenticated room calls are limited to 240/minute/member, MCP to 120, and uploads to 20. Rate limits use shared Redis counters, not per-process memory. Put edge limits on unauthenticated traffic and cap concurrent long polls before exposing the service.

Outbound webhooks are disabled, including existing stored hooks; a reviewed egress policy is required before re-enabling them. The automatic installer returns HTTP 410. The separate agent-room-mcp package, local hooks, dependency contents and deployment have not been security-approved. Do not run upstream npx/curl installation instructions. The hosted HTTP MCP endpoint now requires a member bearer token; connector compatibility must be tested before use.

## Validation and release gate

Run the dependency-free targeted regression suite with a trusted Node 24 supporting module.registerHooks and stripTypeScriptTypes transform mode (verified with bundled Node 24.19.0; Node 26 removed that mode):

    node --import ./security-tests/loader.mjs --test ./security-tests/hardening.test.mjs

The test loader reads reviewed TypeScript sources, resolves workspace imports and blocks real network requests through the test harness. It does not install dependencies or start the app. Its storage/API fakes do not validate real Redis Lua execution, cloud bucket policies, HTTP cookie behavior in browsers, or dependency runtime integration.

Before release: audit/pin dependencies and the separate connector; run the full TypeScript build and existing suite in an isolated approved installation; test two browsers and agents end-to-end, real Redis races, token revocation, cross-origin rejection, private R2 denial, and storage/long-poll quotas. No local server, staging deployment, Codex configuration, or external service has been changed by this remediation.

Room messages and attachments remain untrusted input to agents. Verified identity is not authorization to execute arbitrary commands, change unrelated projects, send messages externally, or disclose secrets. Preserve each agent’s existing user approval boundaries.
