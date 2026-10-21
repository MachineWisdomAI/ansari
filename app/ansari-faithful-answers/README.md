# Ansari Faithful Answers

A standalone MCP application. `ask_ansari` calls the Ansari API and returns its complete answer and attribution unchanged. SAGA links each result to one content-addressed, self-contained React card. The application owns Ansari branding, floral artwork, theme mapping and Hono HTTP hosting; SAGA owns content interpretation, FaithfulCard rendering, content policy, consent and MCP view linkage.

## How it works

[Explore the interactive walkthrough](docs/show-me-ansari-faithful-answers.html) for the complete question-to-card flow, UI states, code ownership and build process. Download the self-contained HTML and open it in a browser; GitHub displays its source. The walkthrough uses synthetic content and makes no live requests.

## Dependencies

The four SAGA packages use exact public npm versions declared in [`package.json`](package.json). `pnpm check:release` verifies that each exact version exists in the public registry.

The application uses SAGA React’s public `@saga-a2ui/react/a2ui` entry point for surfaces and catalogs. SAGA owns its A2UI and Zod 3 dependency context; the application uses Zod 4 for MCP. Do not add direct `@a2ui/react` or `@a2ui/web_core` dependencies or cast between their schema types. The artwork owner has authorized contribution and redistribution with the application; see `assets/NOTICE.md`.

## Development

Requires Node 22.18 or later and pnpm 10.33. Install the pinned public dependencies:

```sh
pnpm install --strict-peer-dependencies
pnpm check:release
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
pnpm start
```

Run from this directory. `build` writes `dist/view.html` and a bundled `dist/server/index.js`; no parent build or source checkout is needed. `dev` runs the server source after `build`. The synthetic browser harness is test-only and uses no credentials or live answers.

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port (default 3000). |
| `ANSARI_API_BASE_URL` | Ansari API origin (default `https://api.askansari.ai`). |
| `ANSARI_API_AUTHORIZATION` | Optional upstream Authorization header. Supply through the environment; never commit it. |
| `ANSARI_CLIENT` | Upstream client label (default `ansari-faithful-answers`). |
| `MCP_ALLOWED_HOSTS` | Comma-separated additional HTTP Host names, without scheme. Localhost and 127.0.0.1 are allowed by default. Configure the public DEV host when deploying. |
| `MCP_ALLOWED_ORIGINS` | Comma-separated additional allowed browser origins. |
| `MCP_RESPONSE_MODE` | `json` for modern MCP final-answer-only responses; otherwise SSE, which supports client-requested progress notifications. Older-host compatibility responses may use SSE. |
| `ANSARI_RELEASE` | Optional safe release identifier, embedded in served HTML and health/log records. |

`POST /mcp` serves stateless MCP requests through Hono and the official MCP request handler. Modern requests need no initialization; older hosts can use the handler’s stateless compatibility path. No MCP session IDs, session map, expiry timer or replay store are retained. `GET /mcp` and `DELETE /mcp` return 405. `/health` exposes the release. The HTML is read, revision-stamped and fingerprinted once before the listener opens. Each request creates its own lightweight MCP server using that prepared view; resource bytes and identity stay fixed until restart. No demo, font server, alternative renderer or historical resource is served. Tool calls have a fresh 60-second budget; timeout yields a safe error and leaves subsequent calls usable. The budget bounds the MCP reply; it does not promise upstream fetch cancellation.

Closing a request server releases its budget even if it was never connected to a transport. On SIGINT or SIGTERM the listener stops accepting requests, closes MCP handlers and HTTP connections, and exits; unfinished calls are interrupted, including older-host SSE calls. This does not guarantee that upstream work has stopped.

## Workspace and container

This package lives at `app/ansari-faithful-answers` and uses the repository's root pnpm lockfile. Install from the repository root with `pnpm install --frozen-lockfile`. Run app commands with `pnpm faithful-answers <script>` or from this directory. Start it explicitly with `pnpm faithful-answers dev`; the existing root development command continues to start only the API, auth and frontend applications.

The root workspace pins `@a2ui/markdown-it` to `0.2.1`: A2UI React 0.13 permits adapter 0.2.2, but that adapter requires incompatible web_core 0.14. Keep this override until SAGA's supported dependency combination changes. SAGA's own Markdown parser remains its private dependency. Do not add direct A2UI dependencies to this application.

The Docker build context is this folder:

```sh
docker build -t ansari-faithful-answers .
docker run --rm -p 3000:3000 --env-file .env ansari-faithful-answers
```

The runtime contains only the compiled server and HTML. The build must resolve public packages without private registry credentials. Verify an isolated copy with public dependencies, all tests, and its container before declaring transfer complete.

## Assets

Artwork is embedded as actual SVG/PNG data in application-local TypeScript modules. Kitab Regular and Bold are bundled into the HTML and loaded through binary `FontFace` sources. Some hosts block `data:` font URLs through their outer CSP; using the embedded bytes directly needs no font request or host policy change. Both weights must load before an answer appears, and teardown removes the owned font faces. No device font or font server is required. See `assets/NOTICE.md`. SDK licensing does not grant rights to Ansari artwork.

## Continuous verification

The `Standalone public packages` GitHub Actions job runs on every PR and develop/main
push, separately from the API, auth and frontend jobs. Run the same checks locally with
`bash scripts/verify-standalone.sh` (Node 22, pnpm 10.33, Docker and Chromium
system dependencies required). It copies only this app into a temporary pnpm
workspace, applies the destination-root Markdown adapter override, installs from
public npm with a fresh store, and runs release checks, typechecking, the build,
server tests and browser tests. It then builds the normal Dockerfile and checks
health, synthetic tool calls, complete attribution, safe failure/recovery and
resource identity in a container with no external network or mounted files.
The temporary workspace, container and image are removed on exit.

This job needs no Railway access or host credentials. Deployment and actual
ChatGPT, Claude and Alexa rendering remain separate integration checks.

The footer framework credit is controlled by `BRANDING.showSagaCredit` in
`src/view/branding.ts`. Set it to `false` to remove the credit. Its link uses
the same content policy as answer links; Strict displays an inert text credit.

The HTTP migration used a separate `saga init --a2ui-stack lit-mcp --server hono` reference project from the SDK CLI. The CLI creates new projects; it does not edit an existing application or require this React app to switch to Lit. Hono runs on Node through `@hono/node-server`; the official `@modelcontextprotocol/hono` middleware validates Host and Origin.
