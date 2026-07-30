# Pi

Pi (pi.dev) is the only provider in this fork. One `pi --mode rpc` subprocess per
thread session speaks JSONL over stdio; the `PiAdapter` translates that protocol
into orchestration runtime events. Pi is itself a multi-model harness (Anthropic,
OpenAI, Google, xAI, custom providers from `~/.pi` config), so the model picker
lists pi's catalog instead of per-harness catalogs.

Protocol reference: https://pi.dev/docs/latest/rpc

## Process model

- `startSession` spawns `pi --mode rpc` with the thread's cwd. Session identity
  is pinned with `--session-id <threadId>`, which creates or resumes the pi
  session file — resume needs no cursor bookkeeping beyond the thread id.
- Framing is strict JSONL with LF only. Do not use `node:readline` (it also
  splits on U+2028/U+2029, which are legal inside JSON strings); split on `\n`.
- `stopSession` closes stdin and terminates the subprocess; pi persists its own
  session file continuously, so nothing needs flushing.
- Extensions, skills, prompt templates, themes, and AGENTS.md discovery all run
  inside the pi process exactly as in the TUI.

## Command mapping

| Adapter operation                   | pi RPC                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `startSession`                      | spawn + `get_state` (model, thinkingLevel, sessionName)                                               |
| `sendTurn` (idle)                   | `set_model` / `set_thinking_level` if selection changed, then `prompt` (images as base64 attachments) |
| `sendTurn` (while streaming)        | `prompt` with `streamingBehavior: "steer"`                                                            |
| `interruptTurn`                     | `abort`                                                                                               |
| `respondToUserInput`                | `extension_ui_response` (see Extension dialogs)                                                       |
| `respondToRequest`                  | unsupported — pi has no approval gate (see Semantics)                                                 |
| `readThread`                        | `get_messages`                                                                                        |
| `rollbackThread`                    | `get_entries` → `fork` (see Rollback)                                                                 |
| model catalog (snapshot)            | `get_available_models`                                                                                |
| slash commands + skills (snapshot)  | `get_commands`                                                                                        |
| thinking levels (option descriptor) | `get_available_thinking_levels`                                                                       |

## Event mapping

t3code turn = one user→agent cycle. That is pi's `agent_start` → `agent_settled`
span, NOT pi's `turn_start`/`turn_end` (those are per-assistant-message cycles
inside one run and stay internal to the adapter).

| pi event                                               | runtime event                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| spawn + `get_state` ok                                 | `session.started`, `session.configured`, `thread.started`                                                       |
| `agent_start`                                          | `turn.started` (model from state), `session.state.changed` → `running`                                          |
| `agent_settled`                                        | `turn.completed` (`completed` / `failed` / `interrupted` from settle reason), `session.state.changed` → `ready` |
| `agent_end` with usage                                 | `thread.token-usage.updated`                                                                                    |
| `message_start` (assistant)                            | `item.started` `{itemType: "assistant_message"}`                                                                |
| `message_update` `text_delta`                          | `content.delta` `{streamKind: "assistant_text"}`                                                                |
| `message_update` `thinking_delta`                      | `content.delta` `{streamKind: "reasoning_text"}`                                                                |
| `message_end`                                          | `item.completed`                                                                                                |
| `tool_execution_start`                                 | `item.started` (`bash` → `command_execution`; `edit`/`write` → `file_change`; else `dynamic_tool_call`)         |
| `tool_execution_update`                                | `item.updated`                                                                                                  |
| `tool_execution_end`                                   | `item.completed` `{status: "completed" \| "failed"}`                                                            |
| `bash_execution_update`                                | `content.delta` `{streamKind: "command_output"}`                                                                |
| `compaction_start` / `compaction_end`                  | `item.started` / `item.completed` `{itemType: "context_compaction"}`                                            |
| `auto_retry_start` / `auto_retry_end`                  | `runtime.warning`                                                                                               |
| `extension_error`                                      | `runtime.error` `{class: "provider_error"}`                                                                     |
| `extension_ui_request` (`select` / `confirm`)          | `user-input.requested`                                                                                          |
| `extension_ui_request` (`setStatus` / `setWidget` / …) | acknowledged silently, no event                                                                                 |
| `extension_ui_request` (anything else)                 | auto-cancel via `extension_ui_response` + `runtime.warning`                                                     |
| `queue_update`                                         | ignored — orchestration owns its own queue                                                                      |
| process exit                                           | `session.exited`                                                                                                |

Raw envelopes use `RuntimeEventRaw.source: "pi.rpc.event"`.

## Snapshot

- `installed` / `version` from `pi --version`.
- `models` from `get_available_models` (`provider/id` slugs). Thinking level is
  a `select` option descriptor on every model, sourced from
  `get_available_thinking_levels`.
- `slashCommands` and `skills` from `get_commands` (extension commands, prompt
  templates, skills — all invokable by prefixing the prompt with `/name`).
- `auth`: pi resolves credentials itself (env keys, `pi auth`). The snapshot
  reports authenticated when the model catalog is non-empty.

## Extension dialogs

pi extensions can ask for interactive UI. The three kinds are handled
differently:

- **Status and widget updates** (`setStatus`, `clearStatus`, `setWidget`,
  `clearWidget`) are fire-and-forget. They are acknowledged so the extension
  never blocks, and produce no event — otherwise a normal turn would bury the
  work log under a dozen entries.
- **`select` and `confirm`** become a single-question `user-input.requested`,
  which the composer already renders. The question id is pi's request id, so
  the answer routes straight back: `select` replies with the chosen option's
  label, `confirm` replies `confirmed: true` when the user picked _Yes_.
- **`input` and `editor`** want free-form text, which `UserInputQuestion` has
  no field for. They are cancelled with a visible warning rather than left to
  hang until pi's own dialog timeout fires.

An answer that arrives after pi's timeout has already auto-resolved the dialog
fails with a clear error instead of being silently dropped.

## Rollback

Rolling back N turns re-roots the conversation just before the Nth most recent
user message. `fork` takes a user entry id and starts a new branch from it,
which drops that message and everything after it.

Finding that entry needs care: `get_entries` returns the whole session tree —
pre-compaction history and abandoned branches included — so the adapter walks
parent links back from `leafId` to isolate the active branch before counting
user turns. A fork can be vetoed by a `session_before_fork` extension handler
(`data.cancelled === true`); that surfaces as a failed rollback rather than a
silent no-op.

## Semantics that differ from the removed providers

- **No approval flow.** Pi executes tools without permission gates by design.
  `RuntimeMode` is effectively `full-access`; the adapter rejects
  `respondToRequest` and never emits `request.opened`. Approval UX would be a
  pi extension surfacing through the extension UI protocol, not adapter work.
- **Model switch is in-session** (`set_model` works live), so
  `capabilities.sessionModelSwitch = "in-session"` and
  `requiresNewThreadForModelChange` stays false.
- **Steering.** Pi accepts mid-turn prompts (`steer`), delivered after the
  current assistant turn's tool calls. Follow-ups queue until the agent stops.

## Text generation

Commit messages, PR content, branch names, and thread titles run one-shot
`pi -p --no-session --model <model>` invocations. Default model comes from
`DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER` in `packages/contracts/src/model.ts`.
