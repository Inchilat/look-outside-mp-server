# Look Outside MP — server and host app

Room server and **host app** for [**Look Outside MP**](https://www.nexusmods.com/lookoutside/mods/182), a co-op multiplayer mod (up to 4 players) for
[Look Outside](https://store.steampowered.com/app/3373660/).

> Unofficial fan project, not affiliated with the developers of Look Outside.
> This repository contains the server side only: no game files and no mod. The mod itself is published on Nexus Mods.

- `host/server/` — the room server: a small WebSocket relay (Node.js + [ws](https://github.com/websockets/ws)).
  Players open or join rooms (name, optional password, up to 4 players); the first player of a room is the host and
  the authority on game state. The server knows nothing about the game: it only routes messages.
- `host/app/` — the host app: runs the room server on the player's PC, opens a local control page in the browser
  (addresses to give your friends, open rooms), opens the router port with UPnP. Packaged as a single executable
  for Windows, macOS and Linux.

Players who just want to host a game: download the app (Nexus Mods files or [Releases](../../releases)) and follow
**[Running the server](docs/SERVER.md)**. Everything below is for building it yourself.

## Building the host app

Requirements: [Node.js 22](https://nodejs.org/) (the executable is made from the Node binary that runs the build)
and Git. Build on the system you want the executable for (Windows, macOS or Linux).

```bash
git clone https://github.com/<owner>/<this-repo>.git
cd <this-repo>
npm ci                    # dependencies: ws (runtime), esbuild + postject (build only)
npm test                  # room server + host app tests
npm run build:app         # -> build/look-outside-mp-host-<system>-<arch>[.exe] + build/THIRD-PARTY-NOTICES.txt
node host/app/check-exe.js build/look-outside-mp-host-*   # starts the executable and checks it answers
```

How the build works (`host/app/build.js`):

1. the control page (`dashboard.html`) and the version are embedded in a generated module;
2. [esbuild](https://esbuild.github.io/) bundles the app, the server and `ws` into one JavaScript file;
3. Node's [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) feature
   injects that file into a copy of the `node` binary ([postject](https://github.com/nodejs/postject)); on macOS
   the binary is re-signed ad hoc (`codesign`, from the Xcode command line tools);
4. `THIRD-PARTY-NOTICES.txt` collects the licenses of Node.js and ws, which are inside the executable: ship it
   together with the executable.

The executables are not signed: Windows SmartScreen and macOS Gatekeeper warn the first time (see
[Running the server](docs/SERVER.md)).

### Without building

```bash
npm ci
npm run host                        # host app from the sources: server + control page
node host/server/server.js          # only the room server (PORT=9000 for another port)
```

Docker:

```bash
cd host/server
docker compose up -d --build        # port 8787
```

## Protocol

JSON over WebSocket, field `t` = message type.

```
client -> server   create {name, roomName?, password?} | join {room, name, password?} | list | leave | relay {to?, d}
server -> client   welcome {id, room, roomName, host, players} | error {msg} | rooms {rooms}
                   joined {id, name} | left {id} | closed {reason} | msg {from, d}
```

`relay` forwards `d` to one player (`to`) or to everyone else in the room; the game logic lives in the mod.
`GET /` on the same port answers `look-outside-mp ok - rooms: N` (health check).

## License

[MIT](LICENSE). Look Outside and its assets belong to their authors.
