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

### `GET /activities`

Every enabled activity with its tool count and debug snapshot. For riddle
mode this includes the goal, pool size, every tracked player (state, current
riddle, attempts, solves) and the leaderboard.

```
curl -s http://127.0.0.1:9377/activities
```

### `POST /activities/reset`

Reset one activity's runtime state. Body: `{ "id": "<activityId>" }`.
Returns 404 with the list of available ids if the id is unknown.

```
curl -s -X POST http://127.0.0.1:9377/activities/reset -d '{"id":"riddles"}'
```

This is the fast way to clear riddle progress between live tests without
editing `riddles.state.json` by hand.

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

## Activity layer (riddle mode)

Modes such as riddles are implemented as **activities** layered on top of the
base roleplay bot — `config.game` stays `"llm"`. An activity contributes LLM
tools, prompt sections, `/bot` commands, event hooks and a bio line; the base
bot owns the connection and the turn loop.

Enable it in `config.json`:

```json
"llm": {
    "activities": {
        "riddles": { "enabled": true, "goal": 10 }
    }
}
```

### What the riddle activity adds

| Piece              | Effect                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getRiddles`       | N random riddles (`id`, question, answer), optionally excluding riddles a player already solved.                                                       |
| `getSingleRiddle`  | One random riddle; with a player given, it is assigned immediately. The fallback when the LLM loses the thread in full RP.                             |
| `assignRiddle`     | Records what the LLM actually asked (`riddleId`, or raw `question` + `answer`).                                                                        |
| `markRiddleResult` | **The LLM's verdict.** `correct: true/false`, optional `giveUp`, `guessedAnswer`, `reason`. The only thing that changes progress.                      |
| `getRiddleStatus`  | One player (with their current riddle and answer) or the leaderboard.                                                                                  |
| `clearRiddle`      | Returns a player to idle so they can get the next riddle.                                                                                              |
| `/bot riddles`     | Private whisper with the sender's progress. Also opts them into roleplay (same as `/bot start`). `/bot riddles top`, `/bot riddles reset` (superuser). |

There is no deterministic answer matching: the model judges guesses itself.
The canonical answer is included in the room snapshot per player
(`answersInContext`, default true); set it to `false` if the model leaks
answers into character.

### Where progress lives

`llm.activities.riddles.stateFile` (default `riddles.state.json`). Writes are
debounced and atomic (temp file + rename), and flushed on shutdown. Deleting
the file resets everyone.

### Restraint slots in the character summary

Restraints are rendered as a compact `group:item` list on the summary line,
mirroring how clothing is shown — but with **every slot present**:

```
Loona (member #144334) | female | bio: … | pose: Standing | items: ItemFeet:—, ItemLegs:PawPaddedPetsuitLegs, ItemArms:PawPaddedPetsuitArms, ItemNeck:SpikeCollar, ItemMouth:BallGag, ItemMouth2:—, ItemMouth3:—, ItemHead:LeatherBlindfold, … | naked
```

Why:

- **Every slot is always listed**, with `—` for empty. Omitting an empty slot
  would leave the model unable to tell "empty" from "not reported", which is
  the whole reason for the change.
- The slot list is the **union** of `ITEM_GROUPS` and any item group actually
  present on the character, so a group the catalog does not classify as
  `Category: "Item"` (e.g. `Mask`) can never be silently dropped.
- Order is `ITEM_GROUPS` order with extras appended alphabetically, so the
  line is stable across turns.
- `ItemMouth`, `ItemMouth2` and `ItemMouth3` are three independent slots and
  are reported separately — `bin/hub/logic/kidnappersGameRoom.ts` relies on
  that distinction.
- Vibrator state is folded into the value (`Vibrator [vibe:high]`).
- `restrained` and `gagged` are **not** in the summary: both are derivable
  from the slot list, and a flag disagreeing with the list would be worse
  than either alone. `naked` stays because it also weighs clothing.

Cost is one entry per item group (28 today) per character per turn.

### Prompt layout

- Riddle rules go into the **static** system prompt (`systemSections`), so the
  KV cache stays useful across turns.
- Per-player progress appears under each character in the fresh room-state
  snapshot (`characterAnnotations`): `RIDDLE PLAYER (priority for roleplay)`,
  solve count, current riddle and answer.
- The leaderboard and any in-flight riddles go at the end of the snapshot
  (`roomStateSections`).

### Tool metadata

A tool declares how the agent should treat it, instead of the agent naming it
in a hardcoded list. This is what lets an activity contribute a tool that
blocks `endTurn` or persists to history with no edit to `agent.ts`.

| Field                   | Effect                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `lookup: true`          | Read-only. `endTurn` in the same batch is refused, and the "Wardrobe" emoticon is shown while the model considers the results. |
| `blocksEndTurn: true`   | The result must be inspected before ending the turn (e.g. a room change the server may reject). Implied by `lookup`.           |
| `history: "action"`     | Persist the result into the rolling cross-turn history as an assistant action.                                                 |
| `history: "roomChange"` | Same, tagged as a room change.                                                                                                 |

Without `history`, a result lives only in the current turn's tool message and
is forgotten on the next turn.

Current assignments:

| Tools                                                                                                                          | Flags                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `listItems`, `listClothing`, `listPoses`, `getRiddles`, `getRiddleStatus`                                                      | `lookup`                                  |
| `getSingleRiddle`                                                                                                              | `lookup` + `history: "action"`            |
| `createRoom`, `joinRoom`, `leaveRoom`                                                                                          | `blocksEndTurn` + `history: "roomChange"` |
| `addItem`, `removeItem`, `stripAll`, `setVibrator`, `sendShock`, `lockItem`, `assignRiddle`, `markRiddleResult`, `clearRiddle` | `history: "action"`                       |

The `endTurn` refusal names the tools actually present in the batch, so it
stays accurate as tools are added.

### Tool results must not contain instructions

Tool results report state; they do not tell the model what to do next. The
model reads the result and decides on its own.

- **Successful results:** facts only — never "now call X", "ask this in
  character", or "congratulate them".
- **Error results:** may include a short recovery hint (e.g. `Use listItems to
find valid names`). An error with no hint risks the same mistake looping,
  and errors never reach history anyway.

History is written once per tool, from the tool result, via the `history`
flag. Tools do not push history entries themselves — there is no second
channel to keep in sync.

### Command hub

`/bot` commands are resolved by `CommandHub`, not by `CommandParser` directly.
Contributions are either `replace` (compete for the base slot, highest
priority wins) or `append` (output stacked after the base). Handlers return
text; the hub sends one assembled reply. This is what lets an activity add
to `/bot status` or override it, and what keeps `/bot riddles` private via
`private: true`.

Each contribution can carry advertising metadata:

| Field           | Effect                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `help`          | One-line description. Omit it to keep the command out of `/bot help` (aliases, internal hooks).       |
| `usage`         | Suffix shown after the name, e.g. `"<text>"` → `/bot feedback <text>`.                                |
| `section`       | Help grouping. Defaults to `"General"`, which is always listed first; the rest follow alphabetically. |
| `superuserOnly` | Hide from `/bot help` unless the sender is a superuser.                                               |
| `private`       | Send the assembled reply as a whisper instead of a public reply.                                      |

### `/bot help`

Lists commands dynamically from the hub — nothing is hardcoded, so enabling an
activity adds its section automatically. Always replied as a **private
whisper**: a wall of command text does not belong in public chat.

Filtering:

- contributions without `help` are never listed;
- `superuserOnly` commands (`tools`, `tool`, `toolstatus`) appear **only** for
  superusers, so the operator surface never leaks to regular players;
- several contributions to the same command collapse to one line (the base
  definition wins);
- grouped by section, `General` first, alphabetical within each section.

A regular player sees:

```
Available commands:

[General]
/bot feedback <text> — Send a note to the bot's operator.
/bot help — Show this list of commands.
/bot start — Start roleplaying with the bot — I will reply to you.
/bot status — List current participants and enabled activities.
/bot stop — Stop roleplaying with the bot.

[Riddles]
/bot riddles [top|reset] — Your riddle progress (also opts you into roleplay).
```

A superuser additionally gets `tool`, `tools` and `toolstatus` under `[General]`.

`/bot status` lists participants plus the enabled activity names only — all
riddle detail is behind `/bot riddles`.

## Offline tests

No BC connection or LLM needed:

```
npx tsx bin/games/riddles/riddleTest.ts    # riddle mode
npx tsx bin/llm/commands/hubTest.ts        # command hub
```

The riddle suite covers the CSV parser (quotes, commas in quotes, CRLF, BOM,
embedded newlines), stable ids, de-duplication, random picking, every
state-machine transition, the activity's tools end to end, registry gating and
context injection.

The hub suite covers `/bot help` visibility (superuser filtering, de-duping,
section grouping and ordering), the empty-listing case, and the
replace/append/priority/private dispatch rules.

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
