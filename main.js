// Look Outside MP - Host app.
// Runs the room server on this PC and a local control page (dashboard) in the browser:
// addresses to give your friends, automatic port forwarding (UPnP), open rooms.
//
// Usage: look-outside-mp-host [--port 8787] [--no-browser] [--no-upnp]
//        (or, from the sources: node host/app/main.js ...)
const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { createRoomServer } = require("../server/server.js");
const upnp = require("./upnp");
const assets = require("./assets");

const VERSION = assets.version();
const CONFIG_FILE = path.join(os.homedir(), ".look-outside-mp.json");
const args = process.argv.slice(2);
const argValue = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

// --- settings ------------------------------------------------------------------------------
const config = Object.assign({ port: 8787, upnp: true }, readConfig());
if (argValue("--port")) config.port = Number(argValue("--port"));
if (args.includes("--no-upnp")) config.upnp = false;

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        log(`could not save settings: ${e.message}`);
    }
}

// --- log -------------------------------------------------------------------------------------
const logLines = [];
function log(s) {
    const line = `${new Date().toLocaleTimeString()}  ${s}`;
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
    console.log(line);
}

// --- room server ------------------------------------------------------------------------------
const state = {
    roomServer: null,
    port: null,
    error: null,
    upnp: { state: "off", message: "", externalIp: null, mapping: null },
    publicIp: null,
};

async function startRoomServer(port) {
    if (state.roomServer) {
        await closeUpnp();
        await state.roomServer.close();
        state.roomServer = null;
    }
    const server = createRoomServer({ log });
    try {
        state.port = await server.listen(port, "0.0.0.0");
        state.roomServer = server;
        state.error = null;
        log(`room server listening on port ${state.port}`);
        if (config.upnp) openUpnp();
    } catch (e) {
        state.port = null;
        state.error = e.code === "EADDRINUSE" ? `Port ${port} is already in use (is another copy of the app running?)` : e.message;
        log(`room server not started: ${state.error}`);
    }
}

// --- port forwarding (UPnP) ------------------------------------------------------------------
async function openUpnp() {
    if (!state.port || state.upnp.state === "working") return;
    state.upnp = { state: "working", message: "Asking the router to open the port...", externalIp: null, mapping: null };
    try {
        const m = await upnp.openPort(state.port);
        state.upnp = { state: "on", message: `Port ${m.port} forwarded to ${m.internalIp} by the router (${m.gateway})`, externalIp: m.externalIp, mapping: m };
        if (m.externalIp) state.publicIp = state.publicIp || m.externalIp;
        log(`UPnP: ${state.upnp.message}`);
        if (m.lease) state.upnp.renew = setInterval(() => upnp.openPort(state.port).catch(() => {}), (m.lease / 2) * 1000);
    } catch (e) {
        state.upnp = { state: "error", message: e.message, externalIp: null, mapping: null };
        log(`UPnP: ${e.message}`);
    }
}

async function closeUpnp() {
    const m = state.upnp.mapping;
    if (state.upnp.renew) clearInterval(state.upnp.renew);
    state.upnp = { state: "off", message: "", externalIp: null, mapping: null };
    if (!m) return;
    try {
        await upnp.closePort(m);
        log(`UPnP: port ${m.port} closed`);
    } catch (e) {
        log(`UPnP: could not close the port: ${e.message}`);
    }
}

// --- addresses -------------------------------------------------------------------------------------
function addresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family !== "IPv4" && a.family !== 4) continue;
            if (a.internal) continue;
            out.push({ ip: a.address, interface: name, kind: addressKind(a.address, name) });
        }
    }
    return out;
}

function addressKind(ip, name) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 100 && b >= 64 && b <= 127) return /zerotier/i.test(name) ? "vpn" : "tailscale";
    if (a === 26) return "radmin";
    if (a === 25) return "hamachi";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return /zerotier|zt/i.test(name) ? "vpn" : "lan";
    if (a === 169 && b === 254) return "link-local";
    return "other";
}

function publicIp() {
    return new Promise((resolve, reject) => {
        https
            .get("https://api.ipify.org?format=json", { timeout: 5000 }, res => {
                let data = "";
                res.on("data", c => (data += c));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data).ip);
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .on("timeout", function() {
                this.destroy(new Error("timeout"));
            })
            .on("error", reject);
    });
}

// --- dashboard (only reachable from this PC) -----------------------------------------------------
const token = crypto.randomBytes(16).toString("hex");

function status() {
    const s = state.roomServer ? state.roomServer.status() : { connections: 0, rooms: [] };
    return {
        version: VERSION,
        port: state.port,
        error: state.error,
        addresses: addresses(),
        publicIp: state.publicIp,
        upnp: { enabled: config.upnp, state: state.upnp.state, message: state.upnp.message, externalIp: state.upnp.externalIp },
        connections: s.connections,
        rooms: s.rooms,
        log: logLines.slice(-60),
        configFile: CONFIG_FILE,
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => {
            data += c;
            if (data.length > 1e5) req.destroy();
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(e);
            }
        });
    });
}

function json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
}

const api = {
    "GET /api/status": async () => status(),
    "POST /api/upnp": async b => {
        config.upnp = !!b.enable;
        saveConfig();
        if (config.upnp) await openUpnp();
        else await closeUpnp();
        return status();
    },
    "POST /api/public-ip": async () => {
        state.publicIp = await publicIp();
        return status();
    },
    "POST /api/port": async b => {
        const port = Number(b.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("The port must be a number between 1024 and 65535");
        config.port = port;
        saveConfig();
        await startRoomServer(port);
        return status();
    },
};

const dashboard = http.createServer(async (req, res) => {
    // only this PC, only with the token from the console/browser link (other websites can't drive it)
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(host)) {
        res.writeHead(403);
        return res.end();
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== token) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end("Open the link shown in the Look Outside MP window.");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(assets.dashboard().replace("__TOKEN__", token));
    }
    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) {
        res.writeHead(404);
        return res.end();
    }
    if (req.headers["x-token"] !== token) return json(res, 403, { error: "bad token" });
    try {
        json(res, 200, await handler(req.method === "POST" ? await readBody(req) : {}));
    } catch (e) {
        json(res, 400, { error: e.message });
    }
});

function listenDashboard(port) {
    return new Promise((resolve, reject) => {
        dashboard.once("error", reject);
        dashboard.listen(port, "127.0.0.1", () => {
            dashboard.off("error", reject);
            resolve(dashboard.address().port);
        });
    });
}

function openBrowser(url) {
    const [cmd, cmdArgs] =
        process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    execFile(cmd, cmdArgs, { windowsHide: true }, () => {});
}

// --- start / stop ------------------------------------------------------------------------------------
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping...");
    const timer = setTimeout(() => process.exit(0), 4000);
    await closeUpnp();
    if (state.roomServer) await state.roomServer.close();
    clearTimeout(timer);
    process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
        process.on(sig, stop);
    } catch {
        /* signal not available on this platform */
    }
}

(async () => {
    if (process.platform === "win32") process.title = "Look Outside MP - Host";
    console.log(`Look Outside MP - Host v${VERSION}\n`);
    await startRoomServer(config.port);
    let dashPort;
    for (const p of [argValue("--dashboard-port") != null ? Number(argValue("--dashboard-port")) : 8786, 0]) {
        try {
            dashPort = await listenDashboard(p);
            break;
        } catch {
            /* busy: try a random port */
        }
    }
    const link = `http://127.0.0.1:${dashPort}/?t=${token}`;
    console.log("\n  Control page (only on this PC):");
    console.log(`  ${link}\n`);
    if (state.port) {
        console.log(`  Addresses for the players (F6 panel: Server address, Port ${state.port}):`);
        console.log(`    this PC                  localhost`);
        for (const a of addresses()) console.log(`    ${(a.kind + " (" + a.interface + ")").padEnd(24)} ${a.ip}`);
    }
    console.log("\n  Keep this window open while you play. Close it (or press Ctrl+C) to stop the server.\n");
    if (!args.includes("--no-browser")) openBrowser(link);
})();
