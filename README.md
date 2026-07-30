# d4

d4 is an installable desktop GUI for the [Pi coding agent](https://pi.dev). It keeps the UI and event-sourced architecture of [T3 Code](https://github.com/pingdotgg/t3code), while using Pi as its only agent provider.

Pi supplies the model catalog, provider credentials, sessions, extensions, skills, prompt templates, and compaction. d4 talks to Pi through its RPC protocol instead of adding adapters for other coding harnesses.

## Requirements

- Node.js 22+
- [Vite+](https://viteplus.dev)
- [Pi](https://pi.dev/docs/latest/sdk), authenticated with at least one model provider
- Rust, for the desktop resource monitor

```bash
npm install -g @earendil-works/pi-coding-agent
curl -fsSL https://vite.plus | bash
```

## Development

```bash
vp i
vp run dev:desktop
```

Development state is isolated under `~/.d4/dev`. Linked git worktrees use their own ignored `.d4` directory. Set `D4_HOME` or pass `--base-dir` when an explicit isolated location is needed.

## Build the desktop app

```bash
vp run build:resource-monitor
vp run dist:desktop:dmg:arm64
```

The macOS installer is written to `release/d4-<version>-arm64.dmg`.

The packaged app includes Electron, the web renderer, and the local server. It stores production state under `~/.d4/userdata`, uses the `d4` Electron profile, registers `d4://`, and has bundle ID `com.d4.desktop`.

## Verification

```bash
vp run --filter @t3tools/desktop test
vp run --filter @t3tools/desktop typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
```

Use a temporary `D4_HOME` for smoke tests and packaged launches. Never point d4 development or tests at T3 Code's `~/.t3/userdata`.

## Pi integration

See [docs/providers/pi.md](./docs/providers/pi.md) for the RPC adapter, supported commands, model discovery, event mapping, and test harness.

## Attribution

d4 is derived from T3 Code, licensed under MIT. See [LICENSE](./LICENSE).
