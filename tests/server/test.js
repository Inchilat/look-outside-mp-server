// Server test: host + 3 clients, full room, relay, client leaving, host closing the room.
const assert = require("assert");
const WebSocket = require("ws");
const { createRoomServer } = require("../../host/server/server");

function client(url) {
    return new Promise(resolve => {
        const ws = new WebSocket(url);
        ws.queue = [];
        ws.waiters = [];
        ws.on("message", raw => {
            const m = JSON.parse(raw);
            const i = ws.waiters.findIndex(w => w.t === m.t);
            if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(m);
            else ws.queue.push(m);
        });
        ws.sendJson = o => ws.send(JSON.stringify(o));
        ws.waitFor = t =>
            new Promise((res, rej) => {
                const i = ws.queue.findIndex(m => m.t === t);
                if (i >= 0) return res(ws.queue.splice(i, 1)[0]);
                const timer = setTimeout(() => rej(new Error("timeout " + t)), 2000);
                ws.waiters.push({ t, resolve: m => (clearTimeout(timer), res(m)) });
            });
        ws.on("open", () => resolve(ws));
    });
}

(async () => {
    const server = createRoomServer({ log: () => {} });
    const port = await server.listen(0, "127.0.0.1");
    const url = `ws://127.0.0.1:${port}`;

    const host = await client(url);
    host.sendJson({ t: "create", name: "Fabio" });
    // default room name: "<name>'s room"
    const w = await host.waitFor("welcome");
    assert.equal(w.host, w.id);
    const code = w.room;
    assert.match(code, /^[A-Z0-9]{5}$/);
    assert.equal(w.roomName, "Fabio's room");

    const others = [];
    for (const name of ["Anna", "Bea", "Carlo"]) {
        const c = await client(url);
        c.sendJson({ t: "join", room: code.toLowerCase(), name });
        const cw = await c.waitFor("welcome");
        assert.equal(cw.host, w.id);
        c.myId = cw.id;
        const j = await host.waitFor("joined");
        assert.equal(j.name, name);
        others.push(c);
    }
    const fifth = await client(url);
    fifth.sendJson({ t: "join", room: code, name: "TooMany" });
    assert.equal((await fifth.waitFor("error")).msg, "Room is full");
    assert.equal(server.status().rooms[0].players.length, 4);

    // broadcast
    host.sendJson({ t: "relay", d: { type: "pos", x: 3 } });
    for (const c of others) {
        const m = await c.waitFor("msg");
        assert.equal(m.d.x, 3);
        assert.equal(m.from, w.id);
    }
    // direct: only Bea must receive it
    host.sendJson({ t: "relay", to: others[1].myId, d: { type: "private" } });
    assert.equal((await others[1].waitFor("msg")).d.type, "private");
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!others[0].queue.some(m => m.t === "msg" && m.d.type === "private"));

    // a client leaves
    others[2].close();
    assert.ok((await host.waitFor("left")).id);

    // the host leaves: the room closes
    host.close();
    assert.equal((await others[0].waitFor("closed")).t, "closed");
    assert.equal((await others[1].waitFor("closed")).t, "closed");
    assert.equal(server.status().rooms.length, 0);

    // room list, names and passwords
    const lister = await client(url);
    lister.sendJson({ t: "list" });
    assert.deepEqual((await lister.waitFor("rooms")).rooms, []);
    const h2 = await client(url);
    h2.sendJson({ t: "create", name: "Marco", roomName: "  Night shift  ", password: "secret" });
    const w2 = await h2.waitFor("welcome");
    assert.equal(w2.roomName, "Night shift");
    const h3 = await client(url);
    h3.sendJson({ t: "create", name: "Sara" });
    const w3 = await h3.waitFor("welcome");
    lister.sendJson({ t: "list" });
    const list = (await lister.waitFor("rooms")).rooms;
    assert.deepEqual(list.map(r => [r.name, r.host, r.players, r.max, r.locked]).sort(), [["Night shift", "Marco", 1, 4, true], ["Sara's room", "Sara", 1, 4, false]]);
    assert.ok(!JSON.stringify(list).includes("secret"), "the password must not be listed");
    const g = await client(url);
    g.sendJson({ t: "join", room: w2.room, name: "Guest" });
    assert.equal((await g.waitFor("error")).msg, "This room needs a password");
    g.sendJson({ t: "join", room: w2.room, name: "Guest", password: "nope" });
    assert.equal((await g.waitFor("error")).msg, "Wrong password");
    g.sendJson({ t: "join", room: w2.room, name: "Guest", password: "secret" });
    assert.equal((await g.waitFor("welcome")).host, w2.id);
    // an old mod joining without a code: refused while there is more than one room
    const old = await client(url);
    old.sendJson({ t: "join", name: "Old" });
    assert.equal((await old.waitFor("error")).msg, "Pick a room from the list");
    h2.close();
    await g.waitFor("closed");
    old.sendJson({ t: "join", name: "Old" });
    assert.equal((await old.waitFor("welcome")).room, w3.room, "single open room: joined without a code");
    g.sendJson({ t: "join", room: w2.room, name: "Late" });
    assert.match((await g.waitFor("error")).msg, /Room not found/);
    lister.sendJson({ t: "list" });
    assert.deepEqual((await lister.waitFor("rooms")).rooms.map(r => r.players), [2]);
    for (const c of [h3, old, g, lister]) c.close();

    console.log("SERVER TEST OK");
    await server.close();
    process.exit(0);
})().catch(e => {
    console.error("TEST FAILED", e);
    process.exit(1);
});
