# Ropeybot

A node-based BC bot based on the old bot-api. Its functionality is divided up into
'games' and you configure the bot to run one of them via its config file.

Most code here is free to use (Apache licensed) but some is taken with
permission from the original bot hub (eg. kidnappers game, roleplay challenge).

We hope that this will be useful for people to make fun and interesting bots
for the club! You're also welcome to run the bots included yourself.

To make a new game, you can copy the 'petspa' game file and use that as a base, and add
your new file into bot.ts.

Usual club ettiquette applies, eg:

- Make sure people know your bot is a bot, not a real player
- Make sure people consent before your bot binds them / changes their clothing etc.
- Watch how many messages your bot sends. Even if it stays under the ratelimit, constantly
  sending messages will affect the server.
- Make bots fun / interesting / useful, rather than to just sit in rooms.

## Code layout

Anything in src/hub is from the original bot hub. This includes the 'kidnappers' game and the
roleplay challenge bot. These are copied in as they were, but with additions since.

Things in src/games use a newer, more event-based API. If you write new bots, they should
probably look like the ones in here.

Some things are unfinished and imperfect, but there should be enough here to make working and
fun bots! Improvements and fixes are always welcome.

## Running

The bot can either be run locally or via the Docker image.

### Running Locally

- Get an environment with NodeJS, pnpm (https://pnpm.io/installation) and git
- Check out the bot's code
  `git clone https://github.com/FriendsOfBC/ropeybot.git`
- Copy `config.sample.json` to `config.json` and customise it: you'll need to provide
  at least a username and password for an account that the bot can log in as. You can
  also choose what game the bot will run.
- Enter the directory and install the dependencies:
  `cd ropeybot`
  `pnpm install`
- Start the bot!
  `pnpm start`

### Running with Docker

- Install docker
- Create a config file as in the steps for running locally
- Run the bot, mapping in the config file you just made:
  `docker run --rm -it -v ${PWD}/config.json:/bot/cfg/config.json ghcr.io/FriendsOfBC/ropeybot:main`
- Alternatively you can build the docker container yourself:
  `docker build --tag ropeybot .`
- And then run said container with the config file mapped in
  `docker run --rm -it -v ${PWD}/config.json:/bot/cfg/config.json ropeybot`

## Games

The bot comes with some built games. In brackets is the value to use for 'game' in the config
file to run that game.

### Dare Game ('dare')

A very simple game where players add dares and then draw them without knowing who added
each dare.
The dares added by players are stored in two files in the bot's working directory:
dares.json and unuseddares.json: delete both of these files to reset the dares.

### Pet Spa ('petspa')

This is an example of how to use the API to make an interactive map room, but also
applies to non map rooms. You can use this file as a base for things like how to react
when players enter areas on a map, adding restraints and setting their properties, sending
and reacting to messages.

### Kidnappers ('kidnappers')

From the original bot hub. Code is mostly unmodified from its original state.

### Roleplay challenge ('roleplay')

Also from the original bot hub.

### Maid's Party Night ('maidspartynight')

Also from the original bot hub, a single player adventure. Needs a second bot account
(user2 and password2 in the config). Probably buggy!

### LLM Roleplay Bot ('llm')

A roleplay bot driven by a locally-served LLM (e.g. [llama.cpp](https://github.com/ggml-org/llama.cpp)'s
`llama-server`). The bot watches the room (chat, item changes, pose changes, people
entering/leaving) and decides how to react — chatting, applying/removing items, changing
poses, etc. — using the LLM's native tool calling.

It is intentionally conservative and safety-first:

- **Safewords**: if a character says a configured safeword, the bot immediately removes any
  items it placed on them and suspends all actions toward them for a cooldown period.
- **Rate limiting**: actions are throttled per-target and globally so the bot never spams.
- **Permissions**: the bot only acts on characters it is allowed to, and never on
  superusers or protected members.

#### Running llama-server

The bot talks to an OpenAI-compatible `/v1/chat/completions` endpoint. Start `llama-server`
pointing at a GGUF model, for example:

```
llama-server \
    -m /path/to/your-model.gguf \
    --host 127.0.0.1 \
    --port 8080 \
    --ctx-size 4096 \
    --jinja
```

The `--jinja` flag enables the chat template and native tool calling, which the bot relies on.

#### Configuration

Set `"game": "llm"` and fill in the `llm` section of your config (see `config.sample.json`):

- `url` / `model`: the llama-server URL and model name.
- `persona`: the system prompt describing who the bot is.
- `allowedTools` / `deniedTools`: restrict which tools the LLM may call (empty = all).
- `safewords` / `safewordSuspendMs`: the safeword list and how long to suspend after one is used.
- `maxActionsPerMinute` / `targetCooldownMs`: anti-spam pacing.
- `maxToolIterations`: how many tool calls the LLM may chain per turn.
- `startPose`: optional pose(s) applied to the bot itself on start.
