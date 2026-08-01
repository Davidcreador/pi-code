# piCode Edge-Case Remediation — Detailed Implementation Plan

Date: 2026-07-31
Sources: three independent read-only audits (desktop, server, web) — full reports at
`/tmp/picode-audit-desktop.md`, `/tmp/picode-audit-server.md`, `/tmp/picode-audit-web.md` —
plus parent verification of d4→piCode update-feed continuity.

## Ground rules (apply to every task)

- One finding = one commit, with a focused behavioral test in the same commit.
- Verification per repo conventions: `vp test run <files>` + `vp run --filter <package> typecheck`.
  No repo-wide checks. Desktop smoke/packaged launches use a temporary `D4_HOME`.
- Shortest correct diff. No new abstractions, no migrations, no compatibility layers.
- Never commit/push without explicit approval; stage and show the diff first.
- The 62-file piCode rename diff is still uncommitted. **Land it (or park it) before starting
  this plan** so fix diffs stay isolated.

Effort key: S = <1h, M = half-day, L = 1–2 days.

---

# Phase 1 — Ship-blockers & data loss

## 1.2 Auto-bootstrap binds threads to non-existent "codex" provider (server, S) — DO FIRST

**Problem.** `getAutoBootstrapDefaultModelSelection()` in
`apps/server/src/serverRuntimeStartup.ts:164-166` returns
`instanceId: ProviderInstanceId.make("codex")` — an upstream-T3 leftover. This fork ships only
`PiDriver` (`apps/server/src/provider/builtInDrivers.ts:33`). With
`autoBootstrapProjectFromCwd` defaulting to true in web mode
(`apps/server/src/cli/config.ts:309-317`), the welcome thread's first turn resolves
`getInstanceInfo("codex")` and fails: _"Thread references unknown provider instance 'codex'"_
(`ProviderCommandReactor.ts:404-417`).

**Fix.**

1. In `serverRuntimeStartup.ts`, change the bootstrap selection to the pi default instance —
   same source of truth as default settings (`packages/contracts/src/settings.ts:312` uses
   `ProviderInstanceId.make("pi")`). Prefer deriving via the existing helper
   (`defaultInstanceIdForDriver(PI)` or the settings default) over a new literal.
2. Audit `serverRuntimeStartup.ts` for any other `"codex"` literals while there.

**Tests.**

- Extend `apps/server/src/serverRuntimeStartup.test.ts`: assert
  `getAutoBootstrapDefaultModelSelection().instanceId` resolves against `BUILT_IN_DRIVERS`
  (loop drivers → instance ids; membership assertion, not a string literal, so the test
  survives future driver changes).

**Verify.** `vp test run apps/server/src/serverRuntimeStartup.test.ts` ·
`vp run --filter t3 typecheck`.

---

## 1.6 Pi auth-flow poll failure locks the management dialog open (web, M)

**Problem.** `apps/web/src/components/PiManagementCommandDialog.tsx:303-336`: the `/login`
flow poll effect re-arms only via `setAuthFlow(result.value)` (line 317). Both failure paths
(typed failure at 314, thrown/transport failure at 324-330) set an error but never update
`authFlow`, so polling stops while `authFlow.status` stays `"running"` → `authActive`
(line 349) stays true → Close button disabled (line 760) and Escape/backdrop dismissal
blocked (line 363). If the environment disconnected, "Cancel sign-in" also fails → user
trapped until reconnect.

**Fix.**

1. On poll failure, do **not** freeze: schedule a retry with backoff (e.g. 1s → 2s → 4s,
   cap 10s) driven by a retry counter in state so the effect re-runs; keep showing the error
   inline.
2. Add an escape hatch: `authActive` must not gate dismissal when the last poll failed —
   either derive `authActive` as `flow.status === "running" && !pollStalled`, or always allow
   Close and fire a best-effort cancel on close.
3. When a later poll shows the server flow completed/failed, reconcile normally.

**Tests.** New `PiManagementCommandDialog` test (or extract the poll logic into a testable
helper next to the existing `.logic` pattern):

- poll rejection → dialog remains dismissible, retry scheduled;
- poll typed-failure → same;
- flow completing after a failed poll → success state reconciles.

**Verify.** `vp test run apps/web/src/components/<new test file>` ·
`vp run --filter @t3tools/web typecheck`.

---

## 1.3 Revert-to-turn-0 fallback destroys pre-thread uncommitted work (server, M) — data loss

**Problem.** The turn-0 baseline ref is the only capture of the user's pre-existing dirty
worktree. Its capture can fail silently — `CheckpointReactor.ts:733-747` only logs a warning
(`processInputSafely`). If the user reverts to turn 0 and the ref is missing,
`restoreCheckpoint` falls back to HEAD (`fallbackToHead`, `GitVcsDriver.ts:737-773`;
enabled at `CheckpointReactor.ts:658-663`) and runs
`git restore --source HEAD … && git clean -fd`, erasing all uncommitted/untracked pre-thread
changes. Unrecoverable.

**Fix.**

1. `GitVcsDriver.restoreCheckpoint` / `CheckpointReactor`: when `turnCount === 0` and the
   baseline ref cannot be resolved, **fail the revert** with a typed error → reactor appends
   an explanatory failure activity ("Baseline snapshot is unavailable; revert would discard
   work that predates this thread."). Only fall back to HEAD when the baseline commit equals
   HEAD (provably safe).
2. Surface baseline-capture failure at capture time as a thread activity (not just a log
   line) so users learn revert-to-start is unavailable _before_ they need it.

**Tests.** Extend `CheckpointReactor.test.ts` + `GitVcsDriver`/Core tests:

- dirty worktree + missing turn-0 ref → revert fails, worktree untouched, failure activity
  appended;
- baseline == HEAD → fallback still permitted;
- baseline-capture failure emits an activity.

**Verify.** `vp test run apps/server/src/orchestration/Layers/CheckpointReactor.test.ts
apps/server/src/vcs/GitVcsDriver.test.ts` · `vp run --filter t3 typecheck`.

---

## 1.4 Checkpoint revert is non-atomic and allowed mid-turn (server, L)

**Problem.** Two related holes:

- _Ordering:_ `CheckpointReactor.ts:678-737` restores the filesystem **before**
  `rollbackConversation`. Provider rollback can fail (`PiAdapter.ts:1366-1405`: fewer user
  turns than requested, extension-cancelled fork, RPC error) → files reverted while the read
  model/transcript still contains rolled-back turns and stale refs remain; later checkpoint
  diffs use the wrong baseline.
- _Guard:_ the decider accepts `thread.checkpoint.revert` with only `requireThread`
  (`decider.ts:660-676`) — nothing rejects it while `session.status === "running"`, so
  `git clean -fd` can race pi writing files mid-turn.

**Fix.**

1. Decider invariant: reject `thread.checkpoint.revert` while the thread's session is
   `starting`/`running` (mirror the existing `requireThreadNotArchived` style in
   `commandInvariants.ts`). Client sees a typed rejection → UI can say "stop the turn first".
2. Reorder the reactor: perform provider rollback (or validate it will succeed) **before**
   touching the filesystem. If provider rollback fails → append failure activity, leave FS
   untouched. If FS restore then fails after a successful provider rollback, append a
   distinct failure activity describing the divergence (rare, but now visible instead of
   silent).

**Tests.** `CheckpointReactor.test.ts` + `decider.test.ts` (or wherever decider invariants
are tested):

- revert command while session running → rejected;
- provider rollback failure → FS untouched, failure activity;
- happy path unchanged (existing tests keep passing).

**Verify.** `vp test run apps/server/src/orchestration/decider.test.ts
apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` ·
`vp run --filter t3 typecheck`.

---

## 1.5 Pi RPC has no timeouts; hung pi wedges the adapter (server, L)

**Problem.** Three compounding gaps:

- `piRpc.ts:228-236`: `request` awaits a `Deferred` forever; only process exit fails pending
  requests. A live-but-unresponsive pi hangs `prompt`/`get_state`/`fork`/`compact`/… and any
  WS RPC awaiting them.
- `PiAdapter.ts:466,1067-1120`: `startSession` holds the **global** `sessionOwnershipLock`
  across `spawnPiRpc → get_capabilities → get_state`; a hang there blocks _every_ subsequent
  session start on the adapter.
- `piRpc.ts:192-204`: `terminate` = SIGTERM + `awaitExit` with no SIGKILL escalation; a
  process ignoring SIGTERM hangs stop paths including the adapter finalizer at shutdown.
- Related (fold in here or as follow-up): `piRpc.ts:113-116` stdin-pump death makes `send` a
  silent no-op — mark transport broken when the pump ends (server audit finding 16).

**Fix.**

1. `piRpc.request`: add a per-request timeout (default generous, e.g. 60s for control calls;
   make it a parameter so long-running calls like `prompt` can opt out or use a larger
   budget) → fail the Deferred with a typed `PiRpcError` timeout; remove the entry from the
   pending map.
2. `terminate`: after SIGTERM, race `awaitExit` against a grace period (e.g. 5s); on expiry
   send SIGKILL and await exit again.
3. `startSession`: wrap the spawn/handshake in a timeout **inside** the lock, or restructure
   so the lock only covers the claim bookkeeping (narrowest correct scope). A handshake
   timeout must terminate the spawned process and release the lock.
4. Stdin-pump: on pump termination while the process is alive, set the broken flag so
   `send`/`request` fail fast instead of enqueueing into the void.

**Tests.** Extend `piRpc.test.ts` (framing/exit harness already exists):

- request against a script that never responds → typed timeout, pending map cleaned;
- terminate against a SIGTERM-ignoring script → SIGKILL path exits;
- send after stdin closed by child → typed failure;
- adapter-level: handshake timeout releases the ownership lock (second start proceeds).

**Verify.** `vp test run apps/server/src/provider/piRpc.test.ts <adapter test>` ·
`vp run --filter t3 typecheck`.

---

## 1.1 Silent quit when the old d4.app holds the single-instance lock (desktop, M)

**Problem.** piCode and the previously installed d4.app share bundle ID `com.d4.desktop` and
Electron profile `d4`, so they contend for one single-instance lock. `DesktopClerk.ts:116-129`:
when `requestSingleInstanceLock` returns false → `electronApp.quit` + `Effect.interrupt` —
no dialog, no visible log. User double-clicks piCode; piCode dies silently; the _old_ app's
window pops up. (Dev is unaffected: dev bundle IDs are per-worktree,
`electron-launcher.mjs:17-22`.)

**Fix (minimal, no identity change).**

1. On lock denial, before quitting, show a blocking `dialog.showErrorBox` (usable pre-ready):
   "piCode is already running — or an older d4 build is. Quit the other app and try again."
2. Log the denial to the desktop log file so support has a trace.
3. Explicitly out of scope: changing profile/bundle identity or takeover handshakes (would
   break the no-migration constraint). Revisit only if user reports demand it.

**Tests.** Extend `DesktopClerk.test.ts`: lock-denied path invokes the error surface then
quits (inject dialog via the existing test seam pattern used for bridge-init failure).

**Verify.** `vp test run apps/desktop/src/app/DesktopClerk.test.ts` ·
`vp run --filter @t3tools/desktop typecheck`.

---

# Phase 2 — High-value reliability

Grouped by subsystem so related fixes share context and tests. Each is still its own commit.

## Group A — Desktop updater (do 2.4 → 2.3 → 2.2 → 2.5 in one sitting)

### 2.4 Updater state machine lost-update races (desktop, M)

`DesktopUpdates.ts:275-287`: `setState`/`updateState` are read-then-write (`Ref.get` … yield …
`Ref.set`); handlers at 558/601/650/682 run as independent fibers via `runEffect` (741-768).
`download-progress` can clobber `update-downloaded`.
**Fix:** funnel every transition through one atomic `Ref.update(state => reduce(state, event))`;
handlers compute the event, not the next state. This is prep for 2.3/2.2 — do it first.
**Test:** interleave `download-progress` after `update-downloaded` → state stays `downloaded`.

### 2.3 Nightly→stable downgrade offer erased by the next poll (desktop, S)

`DesktopUpdates.ts:805-808` enables `allowDowngrade` only for the one channel-change check;
the 4-minute poll (542) re-checks with `allowDowngrade=false` (polls only skipped in
`downloading`/`downloaded`, 356-361) → `update-not-available` wipes `availableVersion`
(601-608) and the Download button vanishes.
**Fix:** compute `allowDowngrade` from "selected channel targets a version line below the
running version" for _every_ check, not just the channel-change one. (Simpler than
suppressing polls, and keeps offers fresh.)
**Test:** channel switch surfaces downgrade offer; subsequent poll preserves it.

### 2.2 Update-install failure strands a windowless app (desktop, M)

`DesktopUpdates.ts:449-521`: `installDownloadedUpdate` stops all backends, destroys all
windows, then `quitAndInstall`. On throw, `quitting` is reset and an error state is emitted —
to zero windows. Win/Linux: headless zombie. macOS: `activate` can't recreate the window
because `backendReady` latched false.
**Fix:** on install failure, run a recovery path: restart the primary backend, recreate/reveal
the main window, then emit the error state. If recovery itself fails → treat as fatal (reuse
`handleFatalStartupError` dialog) and quit.
**Test:** extend the existing install-failure test to assert a window exists and the error
state was delivered to it.

### 2.5 Web update UI models unreachable states (web, M)

`desktopUpdate.logic.ts:15-20,68-76,102-115` branches on `status:"error"` +
`errorContext`, but the desktop reducer (`updateMachine.ts:8-16,169-180`) emits download
failure as `status:"available"` and install failure as `status:"downloaded"` +
`errorContext:"install"` — the web failure branches are dead; real failures render success
tooltips; failed install blocks re-check (`canCheckForUpdate` excludes `downloaded`).
Web tests assert the unreachable shapes (`desktopUpdate.logic.test.ts:46-73`), masking drift.
**Fix:** rewrite the web branches keyed off `errorContext` + `message` on the states the
reducer actually emits; show `state.message` persistently (tooltip/highlight); allow re-check
from a failed-install state. Rewrite the drifted tests **from reducer outputs**: add a
cross-package test that feeds `updateMachine` results directly into the web logic so drift
breaks the build next time.
**Verify (group):** `vp test run apps/desktop/src/updates/DesktopUpdates.test.ts
apps/desktop/src/updates/updateMachine.test.ts
apps/web/src/components/desktopUpdate.logic.test.ts` + both package typechecks.

## Group B — Orchestration lifecycle (server)

### 2.6 Steered turns wedge the session in "running" (server, M)

`PiAdapter.ts:1219-1256`: a second `sendTurn` while running steers pi but mints a new turnId
and re-points `context.activeTurnId`; pi emits no new `agent_start`, so orchestration's
activeTurnId stays at T1; the final `turn.completed` (attributed T2) is dropped by the
conflict guard (`ProviderRuntimeIngestion.ts:1367-1381`) → session stuck "running".
**Fix (adapter-side, preferred):** on steer, keep the original activeTurnId — do not mint a
new turn id for a steered continuation. If product semantics need distinct turn ids later,
instead extend the ingestion guard to accept `turn.completed` whose turn matches the provider
session's tracked turn (mirror the `conflictingTurnStartIsPendingTurnStart` escape at
1352-1360).
**Test:** ingestion test — running turn + steered second send → eventual `turn.completed`
transitions the session out of "running".

### 2.7 Reactors are at-most-once; no replay after crash (server, L)

`OrchestrationEngine.ts:91,329-331`: events broadcast on a PubSub; reactors subscribe live
only (`ProviderCommandReactor.ts:1090-1105`, same in CheckpointReactor, ingestion,
ThreadDeletionReactor). Crash after receipt commit but before the side effect → e.g. a
persisted `thread.turn-start-requested` never spawns a turn; the message sits unadopted.
**Fix:** persist a per-reactor sequence cursor (table or per-reactor row). On `start()`:
replay `readEvents(cursor)` through the same handler before attaching the live stream
(dedupe already exists for turn starts via `handledTurnStartKeys`; extend the pattern where
needed: revert requests, thread deletion cleanup). Advance the cursor after each processed
event.
**Scope control:** start with `ProviderCommandReactor` (user-visible loss) — cursor plumbing
in the engine, other reactors adopt in follow-up commits.
**Test:** engine test — publish event, "crash" (recreate reactor), assert replay processes it
exactly once.

### 2.9 Pi crash leaves user-input requests dangling (server, S)

`PiAdapter.ts:954-993` (`emitUnexpectedExit`) never resolves `context.pendingUiRequests`;
`decider.ts:63-92` then blocks settle/snooze until the user answers a dead prompt whose
failure text happens to clear the block (string-coupled to `stalePendingRequestDetail`).
**Fix:** in `emitUnexpectedExit` (and the stop path if it can leave pendings), synthesize
cancelled `user-input.resolved` activities for all pending request ids — mirror
`cancelUiRequest` (`PiAdapter.ts:790-792`).
**Test:** ingestion/adapter test — open UI request + unexpected exit → resolved(cancelled)
activity emitted; thread settles.

## Group C — Subscriptions & flow control

### 2.10 Hot 250 ms retry loop on expected subscription failures (client-runtime, M)

`threads.ts:295`, `shell.ts:217`: `retryExpectedFailureAfter: "250 millis"` retries
unconditionally; a mounted atom for a deleted/foreign thread re-subscribes ~4×/s forever,
each attempt possibly refetching an HTTP snapshot (threads.ts:255-270).
**Fix:** exponential backoff with cap (250ms → … → 30s) in `subscribeDynamic`'s retry
policy; classify `OrchestrationGetSnapshotError` "not found" as terminal → mark the thread
deleted in state instead of retrying.
**Test:** client-runtime test — not-found failure → no further attempts + deleted marker;
transient failure → backoff schedule.

### 2.11 `d4://` deep links registered but never handled (desktop, decision + S/M)

Prod bundle claims both `d4` and `d4-dev` (`build-desktop-artifact.ts:1578-1583`); dev
launcher re-registers per launch (`electron-launcher.mjs:151-168`); **no `open-url` listener
exists anywhere**, and `second-instance` ignores argv (`DesktopClerk.ts:121-129`);
win32/linux never call `setAsDefaultProtocolClient`.
**Decision needed:** (a) implement deep links (open-url + second-instance argv parse +
win/linux registration + a routing seam), or (b) stop declaring the schemes until a feature
needs them. **Recommendation: (b) minimal now** — drop `d4-dev` from the prod plist
(prevents prod stealing dev activations) and leave `d4` declared-but-inert only if Clerk auth
needs the scheme for callbacks (verify before removing; if Clerk uses it, that's option (a)
scoped to the auth callback path).
**Test:** per chosen option; at minimum assert prod plist scheme list in
`build-desktop-artifact.test.ts`.

### 2.12 Orphaned backends after hard desktop death (desktop+server, M)

`DesktopBackendManager.ts:439-451`: kill handling exists only on graceful scope close; a
SIGKILLed/OOM'd Electron leaves the backend (and pi children) alive, holding the port and
mutating `~/.d4/userdata` concurrently with the next launch's backend.
**Fix:** parent-liveness contract in the server: when spawned by the desktop (flag/env), the
backend watches its stdin/bootstrap fd for EOF (cheap, event-driven) and self-terminates,
with a PPID poll fallback. Desktop side: keep a pipe open to the child for life.
**Test:** server test — spawned with liveness flag + stdin closed → process exits.

### 2.1 Unbounded silent backend restart loop with no window (desktop, M)

`DesktopBackendManager.ts:961-1023`: run-crash restarts are uncapped (only preflight
failures are capped); packaged builds only open a window from `handleBackendReady`
(`DesktopWindow.ts:677-682`) → boot-crash loop = app "doesn't open", forever, silently.
**Fix:** count consecutive `finalizeRun`-without-ready cycles; at N (e.g. 5) stop the
instance and surface a fatal dialog with the child log path (reuse `handleFatalStartupError`
shape). Reset the counter on a successful ready.
**Test:** `DesktopBackendManager.test.ts` — repeatedly-crashing child stops after N attempts
and reports; a ready run resets the counter.

### 2.8 Provider maintenance runner is per-connection (server, S)

`ws.ts:2338-2348` provides `ProviderMaintenanceRunner.layer` inside the per-upgrade layer
stack → each WS connection gets its own update coordinator → two windows can run concurrent
global pi installs.
**Fix:** hoist the runner (or at least `makeProviderMaintenanceCommandCoordinator`) into the
shared singleton runtime layer, passed into the WS layer like `ServerSelfUpdate`
(`ws.ts:2334`).
**Test:** two coordinator handles from two "connections" share the lock (second update
queues, doesn't double-spawn).

---

# Phase 3 — Polish, hygiene, small correctness

Checklist form; each is an independent S/M commit with a focused test where behavior changes.

**Desktop**

- 3.1 Wrap the full `startup` + layer construction with the fatal-error dialog path
  (`DesktopApp.ts:229-251`, `main.ts:210`; Clerk storage / trace-sink failures currently die
  silently). (M)
- 3.2 WSL secondary port: re-scan when a run exits without reaching readiness; port is
  currently pinned at register time and probed on Windows loopback only
  (`DesktopWslBackend.ts:80-93,139-147,173`). (M)
- 3.3 `dev-electron.mjs`: replace `pkill -f -- --t3code-dev-root=…` (path-pattern kill —
  violates repo safety rule) with a PID runtime file; raise the 1.5s SIGKILL budget above the
  app's internal 2s backend grace (`dev-electron.mjs:75,33,67,207`). (M, dev-only)
- 3.4 `smoke-test.mjs`: `mkdtemp` a `D4_HOME` inside the script; require a positive
  readiness signal instead of six fatal-pattern absence (currently uses the real `~/.d4`
  and passes on silent exit) (`smoke-test.mjs:13-56`). (M)
- 3.5 Expose "start in progress" in `DesktopBackendSnapshot` so the WSL "Connecting…" entry
  doesn't flicker during preflight retries (`ipc/methods/window.ts:99-103`). (S)
- 3.6 Small fixes: serialize main-window creation (`DesktopWindow.ts:663-682`); try/catch
  sync IPC listener bodies (`DesktopIpc.ts:126-140`); run skipped cleanup from the
  backgrounded stop fiber (`DesktopBackendManager.ts:1055-1096`); clear cached local bearer
  token on backend shutdown (`DesktopLocalEnvironmentAuth.ts:47-90`); allow persisted bounds
  spanning monitors (`DesktopWindow.ts:117-149`); delete dead `DesktopState.backendReady`
  Ref; drop redundant `exitCode as unknown as number` casts in `DesktopWslEnvironment.ts`
  (verified cosmetic). (S each)

**Server**

- 3.7 GC checkpoint refs: delete `refs/t3/checkpoints/<threadId>/*` in
  `ThreadDeletionReactor` (`ThreadDeletionReactor.ts:44-64`); prune refs beyond the
  500-checkpoint read-model cap at capture time (`projector.ts:40`). (M)
- 3.8 Replace `existsSync(cwd + "/.git")` (`git/Utils.ts:5-7`) with the driver's
  `isInsideWorkTree`; emit a one-time "checkpoints unavailable" activity when a session
  starts in a non-repo cwd. (S)
- 3.9 Decider invariants: reject `thread.turn.start` (and client-path `thread.session.set`)
  on deleted/archived threads (`decider.ts:713-726`, `commandInvariants.ts:100-113`). (S)
- 3.10 `subscribeThread`: apply the shell path's gap cap + snapshot fallback
  (`ws.ts:1565-1585` vs `1459-1476`, `SHELL_RESUME_MAX_GAP`); fixes both the unbounded
  replay and the client stale-cursor freeze (web finding 4) server-side. (M)
- 3.11 Backpressure: bounded per-subscriber buffers with disconnect-on-overflow for WS
  subscription queues (`ws.ts:1413,1541`) — clients already resume by `afterSequence`.
  Leave engine/piRpc queues unbounded for now (single-producer, low risk). (M)
- 3.12 Self-update respawn: replace fixed `sleep 3` shim (`selfUpdate.ts:390-399`) with a
  bind-retry loop (or wait-on-old-PID) so the replacement can't lose the port race. (S)
- 3.13 Smaller: flush/trust `item.completed` fallbackText for buffered assistant text
  (`ProviderRuntimeIngestion.ts:585-605,1029-1044`); TTL-cap `threadModelSelections`
  (`ProviderCommandReactor.ts:218`); append a failure activity when `interruptTurn` fails
  (`ProviderCommandReactor.ts:920-945`). (S each)

**Web**

- 3.14 Client side of 3.10: discard the cursor when a resume replay confirms nothing
  (`threads.ts:200-206`) — belt-and-braces with the server fix. (S)
- 3.15 `onSend` / `onSubmitPlanFollowUp`: wrap in try/finally clearing `sendInFlightRef` +
  local dispatch (`ChatView.tsx:4556-4952,5134-5290`). (S)
- 3.16 Attach a no-op `.catch` to `turnAttachmentsPromise` at creation
  (`ChatView.tsx:4721-4729`). (S)
- 3.17 Keybindings: reset when-expression validity when the popover closes; key row drafts
  by stable identity instead of resolved-config index; per-row saving flag
  (`KeybindingsSettings.tsx:594-616,868,892,1031,1054`, `.logic.ts:166`). (M)
- 3.18 Small fixes: handle credentials-changed wakeups inside the connection probe loop
  (`supervisor.ts:437-446`); narrow `isTransientBootstrapError` beyond bare `TypeError`
  (`auth.ts:308-318`); add the `cancelled` flag to `PiNativeCommandDialog`'s load effect
  (`PiNativeCommandDialog.tsx:121-186`); revoke object URLs on unresolvable-draft early
  returns (`composerDraftStore.ts:2855-2870`); cap version-skew dismissal storage
  (`versionSkew.ts:118-131`); hoist SidebarUpdatePill dismissal to session scope
  (`SidebarUpdatePill.tsx:63-64`); shared formatter for scoped-models summary
  (`PiManagementCommandDialog.tsx:236-244` vs `806`). (S each)

**Release hygiene**

- 3.19 Clean `release/` before packaging/publishing — stale `d4-0.0.31-*` artifacts sit next
  to `piCode-0.0.31-*` and publish globs (`release/*.blockmap`) would upload both. Add an
  explicit clean to the dist script. (S)
- 3.20 Update `scripts/release-smoke.ts` fixtures from `T3-Code-*` to current `piCode-*`
  naming so the manifest-merge smoke exercises reality. (S)
- 3.21 Document (README/release notes): macOS in-place auto-update keeps the old `d4.app`
  folder name on disk while contents/branding become piCode — cosmetic, expected. (S)

---

# Phase 4 — Test-coverage debt (parallel track)

1. **Server `ws.ts` (2,385 lines, zero direct tests):** subscription resume (afterSequence
   gaps, live-buffer-before-snapshot ordering, coalescing under bursts), bootstrap turn-start
   cleanup, archive-stop sequencing. Build alongside 3.10/3.11 which touch the same code. (L)
2. **Desktop integration smoke:** packaged/dev binary against a temp `D4_HOME` asserting a
   positive readiness signal (subsumes 3.4; guards 2.1/3.1). (M)
3. **Web dead code:** delete `orchestrationRecovery.ts` + `orchestrationEventEffects.ts`
   (+ their tests) — imported only by their own tests, giving false replay coverage; delete
   unreferenced `SplashScreen.tsx` or wire it. (S)
4. **Cross-package updater test** — done as part of 2.5.
5. **Runtime probes for inconclusive leads:** `CheckpointReactor.ts:762-767` stale comment
   vs real PubSub delivery bug (subscribe two consumers, fire 1k events, assert both receive
   all); adapter rebuild pump-swap window (`ProviderService.ts:324-366`). (S each; may spawn
   new findings)

## Not audited (follow-up candidates)

- `packages/contracts` schema-evolution deep dive and `packages/ssh/tunnel.ts` (crosscut
  auditor was blocked twice; only spot checks exist: error-cause casting at `tunnel.ts:867`,
  shell quoting of packageSpec at `:634`).

---

# Sequencing summary

```
Land/park the piCode rename diff
└─ Phase 1: 1.2 → 1.6 → 1.3 → 1.4 → 1.5 → 1.1
   └─ Phase 2: Group A (2.4→2.3→2.2→2.5) ─ Group B (2.6, 2.9, 2.7) ─ Group C (2.10, 2.8, 2.1, 2.12, 2.11*)
      └─ Phase 3 checklists (any order, subsystem-grouped)
         └─ Phase 4 test debt (start ws.ts tests with 3.10/3.11)
```

`*` 2.11 needs a product decision (implement deep links vs. drop schemes) before coding.

Every commit: focused test files + package typecheck only. Nothing here requires a state
migration or changes technical identity (`~/.d4`, profiles, bundle ID, schemes).
