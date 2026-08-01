Read `/Users/davecodes/.config/agent-harness/HARNESS.md` and follow it unless this file or the user overrides it.

# piCode

piCode is a desktop GUI for the Pi coding agent. It keeps the T3 Code desktop/web UX and event-sourced server architecture, but Pi is the only agent provider.

## Product boundaries

- **Desktop is the product.** `apps/desktop` packages Electron, the web renderer, and the local server into an installable app.
- **Web is the renderer.** `apps/web` is bundled into desktop and can also run locally for development.
- **Pi is the provider.** Provider behavior goes through `apps/server/src/provider/piRpc.ts` and the Pi driver. Do not add Codex, Claude, Cursor, Grok, OpenCode, or other harness adapters.
- **No mobile or marketing surfaces.** Do not recreate removed apps or compatibility code for them.
- **Contracts stay typed.** Wire schemas live in `packages/contracts`; shared client behavior lives in `packages/client-runtime`.

## Identity and state

- Product name: `piCode`
- Production data home: `~/.d4`; runtime state: `~/.d4/userdata`
- Development state: `~/.d4/dev`, or `<worktree>/.d4/userdata` in linked worktrees
- Explicit override: `D4_HOME` or `--base-dir`
- Electron profile: `d4` (`d4-dev` in development)
- Bundle ID: `com.d4.desktop`
- URL schemes: `d4://` and `d4-dev://`

Never read or write T3 Code's `~/.t3/userdata` or Electron profile. Tests and smoke runs must use a temporary `D4_HOME`.

## Architecture

Clients send typed WebSocket requests. The server turns them into commands, a decider produces persisted events, projectors derive the read model, reactors run side effects and emit receipts, and each turn ends with a git checkpoint. Keep provider-specific complexity at the Pi adapter boundary.

Key locations:

- `apps/desktop` — Electron shell, bundled backend, packaging
- `apps/web` — React/Vite renderer
- `apps/server` — WebSocket server, orchestration, Pi adapter, checkpointing
- `packages/contracts` — wire schemas
- `packages/shared` — shared runtime utilities
- `packages/client-runtime` — shared client state and RPC behavior

## Safety

- Never kill by process-name or path pattern. Stop only a PID captured at spawn.
- Never point development or tests at `~/.d4/userdata` or `~/.t3/userdata`.
- Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for development; Vite proxies local traffic.
- Do not edit `.repos/` vendored references.

## Development

- Install: `vp i`
- Desktop dev: `vp run dev:desktop`
- Build desktop: `vp run --filter @t3tools/desktop --filter t3 build`
- Focused tests: `vp test run <files>`
- Targeted typecheck: `vp run --filter <package> typecheck`

Use the smallest relevant verification. Do not run repository-wide checks unless the user asks. Desktop smoke tests and packaged launches must set a temporary `D4_HOME`.

## Code style

- Shortest correct diff; no speculative abstractions or compatibility layers.
- Match surrounding style. No `any`, narrating comments, defensive theater, or swallowed errors.
- Keep orchestration pure, UI dumb, and effects visible.
- User-visible behavior needs a focused behavioral test.
- Preserve external `*.t3.codes` domains and internal `@t3tools/*` package names unless a separate migration explicitly changes them.
