// Look Outside MP - room server.
// WebSocket relay: the first player of a room is the host and the authority on game state.
// The server knows nothing about the game rules: it only routes messages between players.
//
// Protocol (JSON, field "t" = message type)
//   client -> server: create {name, roomName?, password?} | join {room, name, password?} | list
//                     leave | relay {to?, d}
//   server -> client: welcome {id, room, roomName, host, players:[{id,name}]} | error {msg}
//                     rooms {rooms:[{code, name, host, players, max, locked}]}  (answer to list)
//                     joined {id, name} | left {id} | closed {reason} | msg {from, d}
//   A room is listed as soon as it's created; a password, if set, is asked to whoever joins.
//
// Usage: node server.js   (env PORT, default 8787; env HOST, default all interfaces)
// or as a module: require("./server").createRoomServer({ port }).

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_PLAYERS = 4;
const MAX_MESSAGE = 8 * 1024 * 1024; // a full game state can weigh a few MB
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

function createRoomServer(options = {}) {
    const log = options.log || (s => console.log(new Date().toISOString(), s));
    const rooms = new Map(); // code -> { code, name, password, hostId, players: Map(id -> {id, name, ws}), created }
    let nextId = 1;

    function newCode() {
        let c;
        do {
            c = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
        } while (rooms.has(c));
        return c;
    }

    function cleanName(n) {
        const s = String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
        return s || "Player";
    }

    function cleanRoomName(n, owner) {
        const s = String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 32);
        return s || `${owner}'s room`;
    }

    const digest = s => crypto.createHash("sha256").update(String(s)).digest();
    function passwordOk(room, given) {
        if (!room.password) return true;
        return crypto.timingSafeEqual(digest(given || ""), room.password);
    }

    function roomList() {
        return [...rooms.values()].map(r => {
            const host = r.players.get(r.hostId);
            return { code: r.code, name: r.name, host: host ? host.name : "?", players: r.players.size, max: MAX_PLAYERS, locked: !!r.password };
        });
    }

    function send(ws, obj) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    }

    function playerList(room) {
        return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
    }

    function welcome(room, p) {
        send(p.ws, { t: "welcome", id: p.id, room: room.code, roomName: room.name, host: room.hostId, players: playerList(room) });
    }

    function leave(ws) {
        const room = ws.roomCode && rooms.get(ws.roomCode);
        if (!room) return;
        room.players.delete(ws.playerId);
        ws.roomCode = null;
        if (ws.playerId === room.hostId) {
            for (const p of room.players.values()) {
                send(p.ws, { t: "closed", reason: "The host left the room" });
                p.ws.roomCode = null;
            }
            rooms.delete(room.code);
            log(`room ${room.code} closed (host left)`);
        } else {
            for (const p of room.players.values()) send(p.ws, { t: "left", id: ws.playerId });
            log(`#${ws.playerId} left ${room.code}`);
        }
    }

    const httpServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`look-outside-mp ok - rooms: ${rooms.size}\n`);
    });

    const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE });

    wss.on("connection", (ws, req) => {
        ws.playerId = nextId++;
        ws.alive = true;
        ws.address = req.socket.remoteAddress;
        ws.on("pong", () => (ws.alive = true));

        ws.on("message", raw => {
            let m;
            try {
                m = JSON.parse(raw);
            } catch {
                return;
            }
            if (!m || typeof m.t !== "string") return;

            switch (m.t) {
                case "list":
                    send(ws, { t: "rooms", rooms: roomList() });
                    break;
                case "create": {
                    if (ws.roomCode) leave(ws);
                    const code = newCode();
                    const p = { id: ws.playerId, name: cleanName(m.name), ws };
                    const password = String(m.password || "").slice(0, 32);
                    const room = {
                        code,
                        name: cleanRoomName(m.roomName, p.name),
                        password: password ? digest(password) : null,
                        hostId: p.id,
                        players: new Map([[p.id, p]]),
                        created: Date.now(),
                    };
                    rooms.set(code, room);
                    ws.roomCode = code;
                    welcome(room, p);
                    log(`room ${code} "${room.name}"${room.password ? " (password)" : ""} created by #${p.id} ${p.name}`);
                    break;
                }
                case "join": {
                    if (ws.roomCode) leave(ws);
                    let code = m.room ? String(m.room).toUpperCase().trim() : null;
                    // older mods join without a code: only possible when there is a single open room
                    if (!code) {
                        const open = [...rooms.values()].filter(r => !r.password);
                        if (rooms.size === 0) return send(ws, { t: "error", msg: "Nobody is hosting a game on this server yet" });
                        if (open.length !== 1 || rooms.size !== 1) return send(ws, { t: "error", msg: "Pick a room from the list" });
                        code = open[0].code;
                    }
                    const room = rooms.get(code);
                    if (!room) return send(ws, { t: "error", msg: "Room not found (it may have just closed)" });
                    if (!passwordOk(room, m.password)) return send(ws, { t: "error", msg: m.password ? "Wrong password" : "This room needs a password" });
                    if (room.players.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "Room is full" });
                    const p = { id: ws.playerId, name: cleanName(m.name), ws };
                    for (const other of room.players.values()) send(other.ws, { t: "joined", id: p.id, name: p.name });
                    room.players.set(p.id, p);
                    ws.roomCode = code;
                    welcome(room, p);
                    log(`#${p.id} ${p.name} joined ${code}`);
                    break;
                }
                case "leave":
                    leave(ws);
                    break;
                case "relay": {
                    const room = ws.roomCode && rooms.get(ws.roomCode);
                    if (!room) return;
                    const out = JSON.stringify({ t: "msg", from: ws.playerId, d: m.d });
                    if (m.to != null) {
                        const dest = room.players.get(Number(m.to));
                        if (dest && dest.ws.readyState === dest.ws.OPEN) dest.ws.send(out);
                    } else {
                        for (const p of room.players.values()) {
                            if (p.id !== ws.playerId && p.ws.readyState === p.ws.OPEN) p.ws.send(out);
                        }
                    }
                    break;
                }
            }
        });

        ws.on("close", () => leave(ws));
    });

    // keepalive: drops dead connections
    const keepalive = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.alive) {
                ws.terminate();
                continue;
            }
            ws.alive = false;
            ws.ping();
        }
    }, 30000);

    return {
        httpServer,
        wss,
        rooms,
        // summary for dashboards
        status() {
            return {
                connections: wss.clients.size,
                rooms: [...rooms.values()].map(r => ({
                    code: r.code,
                    name: r.name,
                    locked: !!r.password,
                    created: r.created,
                    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, host: p.id === r.hostId })),
                })),
            };
        },
        listen(port, host) {
            return new Promise((resolve, reject) => {
                httpServer.once("error", reject);
                httpServer.listen(port, host, () => {
                    httpServer.off("error", reject);
                    resolve(httpServer.address().port);
                });
            });
        },
        close() {
            clearInterval(keepalive);
            for (const ws of wss.clients) ws.terminate();
            return new Promise(resolve => httpServer.close(() => resolve()));
        },
    };
}

module.exports = { createRoomServer, MAX_PLAYERS };

if (require.main === module) {
    const port = Number(process.env.PORT || 8787);
    const server = createRoomServer();
    server.listen(port, process.env.HOST || undefined).then(p => console.log(new Date().toISOString(), `look-outside-mp server listening on :${p}`));
}
