# Live Bot Debugging Guide (for AI assistants)

This document describes how to drive and inspect the LLM bot **while it runs
against the live BC server**, without a human in the game client. It is written
for an AI assistant (Zoo) working on this repo in a new task: read this first
when you need to test tools or diagnose live behavior.

## Prerequisites

1. The user's `config.json` must have:
   - `"game": "llm"`
   - `"llm.debugPort": <port>` (e.g. `9377`) — enables the debug HTTP server
   - `"llm.llmLog": "llm.log"` (recommended) — enables the JSONL LLM log that
     `/llmlog` reads
   - `"superusers": [...]` — not needed for the debug server, but needed for
     the in-game `!tool` commands
2. The bot process is running: `npx tsx bin/main.ts config.json`
   (start it in the background and redirect output to a log file, e.g.
   `bot.log`, so console output — including `LLM tool call: ...` lines — is
   available).

The debug server binds to **127.0.0.1 only** and is opt-in via `debugPort`.
If the port is not set, none of the endpoints below exist.

## Debug HTTP API

Base URL: `http://127.0.0.1:<debugPort>` (implementation:
[`bin/llm/debugServer.ts`](bin/llm/debugServer.ts)).

All responses are JSON.

### `GET /status`

Agent state snapshot (same data as the in-game `!toolstatus` command):
participants, rate-limit usage, suspended members, leashed members.

```
curl -s http://127.0.0.1:9377/status
```

### `GET /tools`

All tools the LLM currently has (after `allowedTools`/`deniedTools`/`roomTools`
filtering), with full parameter schemas. Use this to check whether a tool is
registered and what args it expects.

```
curl -s http://127.0.0.1:9377/tools
```

### `POST /tool`

Run a tool directly, bypassing the LLM — the same handler the LLM would invoke,
with the live connection and live room state.

Body: `{ "name": "<toolName>", "args": { ... } }` (`args` optional, defaults to `{}`).

Response: `{ "ok": true, "name": ..., "args": ..., "result": "<tool result string>" }`.
Tool errors come back as result strings (e.g. `Error: ...`, `Refused: ...`);
HTTP 500 only for server-side failures.

```
curl -s -X POST http://127.0.0.1:9377/tool -d '{"name":"roomInfo"}'
curl -s -X POST http://127.0.0.1:9377/tool -d '{"name":"searchRooms","args":{"query":"party","space":"X"}}'
curl -s -X POST http://127.0.0.1:9377/tool -d '{"name":"addItem","args":{"name":"Bob","group":"ItemMouth","asset":"BallGag"}}'
```

Note: on Windows `cmd.exe`, JSON in `-d` needs single quotes around the body or
a here-file; in PowerShell use `--data-raw`.

### `GET /toollog?limit=N`

The agent's tool-invocation ring buffer (last 50 entries, oldest first),
covering **both** LLM-driven calls and manual `/tool` calls. Each entry:
`{ ts, source: "llm"|"manual", name, args, result }`.

```
curl -s "http://127.0.0.1:9377/toollog?limit=10"
```

Use this to see what the LLM actually decided to call, with what args, and
what it got back.

### `GET /llmlog?limit=N`

The last N entries of the `llmLog` JSONL file (default 20, max 200). Each entry
is a full LLM request (`kind: "request"` with the complete message history and
options) or response (`kind: "response"` with content, toolCalls, finishReason,
usage, elapsedMs) or error. Entries carry `{ ts, turn, iteration }`.

Returns 404 if `llmLog` is not configured.

```
curl -s "http://127.0.0.1:9377/llmlog?limit=5"
```

### `POST /stop`

Shuts the bot down cleanly (runs the same cleanup as SIGINT: closes the debug
server, stops the agent, restores nickname/bio) and exits the process.
Use it to restart the bot after applying a code fix.

```
curl -s -X POST http://127.0.0.1:9377/stop
```

## Typical debug loop

```
1. Start:   npx tsx bin/main.ts config.json > bot.log 2>&1   (background)
2. Wait:    poll GET /status until the bot is in a room
3. Inspect: GET /tools, GET /llmlog?limit=5
4. Act:     POST /tool for the tool under test
5. Verify:  GET /toollog?limit=5, GET /llmlog?limit=5, check bot.log
6. Fix code, then: POST /stop (or kill the process), recompile if src/ changed
   (cd src && npm run compile), restart from step 1
```

## Gotchas

- **`bc-bot` is a `link:src` package.** After editing anything in `src/`,
  recompile with `cd src && npm run compile` before restarting, or type
  changes won't propagate.
- **Rate limiting.** Tools share a global actions-per-minute limit
  (`llm.maxActionsPerMinute`, default 10). Rapid `/tool` calls will hit it;
  the result string says so.
- **Room-admin tools** (`updateRoom`, `roomAdmin`) refuse unless the bot is an
  admin of the current room (`Refused: the bot is not an admin...`).
- **`createRoom`/`joinRoom`/`leaveRoom` change the bot's room.** After testing
  them, rejoin the configured room with
  `POST /tool {"name":"joinRoom","args":{"name":"<configured room name>"}}`.
- **The LLM is still running.** While the bot is live, the LLM also acts on
  room events. For isolated tool testing, `POST /tool` results are
  distinguishable in `/toollog` by `source: "manual"`.
- **`/tool` result strings are truncated nowhere** — they are the full handler
  return value, so long lists (e.g. `listItems`) come back in full.
- **Console log.** `bot.log` contains `LLM tool call: name(args)` and
  `Manual tool call: name(args)` lines with the first 200 chars of each
  result — useful for correlating with `/toollog`.
- **`updateRoom` requires a full room payload.** The server rejects
  partial updates with `InvalidRoomData`. The tool must send the complete
  current room data (from `room.ToInfo()`) plus the changed fields.
  `ChatRoomUpdate` in `src/apiConnector.ts` now returns a
  `Promise<ServerChatRoomUpdateResponse | "Timeout">` so the tool can
  report the server's verdict instead of blindly claiming success.
- **Restarting the bot.** After `POST /stop`, wait ~8-10 seconds before
  restarting, or the new process will fail to bind the debug port
  (`EADDRINUSE`). The old process takes a moment to fully release it.
- **`ChatRoomUpdate` payload is logged.** `bot.log` contains
  `Updating chat room {...}` lines with the full JSON payload — useful
  for diagnosing server rejections.
