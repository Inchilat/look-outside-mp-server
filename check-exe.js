// Starts the built executable and checks that it really works on this system:
// room server answering, control page reachable with its token, clean exit.
// Usage: node host/app/check-exe.js build/look-outside-mp-host-<system>[.exe]
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const exe = path.resolve(process.argv[2] || "");
if (!fs.existsSync(exe)) {
    console.error("executable not found:", exe);
    process.exit(1);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lomp-exe-"));
const PORT = 18799;

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let d = "";
            res.on("data", c => (d += c));
            res.on("end", () => resolve({ status: res.statusCode, body: d }));
        }).on("error", reject);
    });
}

(async () => {
    const child = spawn(exe, ["--no-browser", "--no-upnp", "--port", String(PORT), "--dashboard-port", "0"], {
        env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (out += d));
    const deadline = Date.now() + 30000;
    let link = null;
    while (!link && Date.now() < deadline) {
        const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
        if (m) link = m[0];
        else await new Promise(r => setTimeout(r, 200));
    }
    if (!link) throw new Error("no control page link in the output:\n" + out);

    const health = await get(`http://127.0.0.1:${PORT}/`);
    if (!/look-outside-mp ok/.test(health.body)) throw new Error("room server not answering: " + health.body);
    const page = await get(link);
    if (page.status !== 200 || !page.body.includes("LOOK OUTSIDE MP")) throw new Error("control page not served");

    // a real room through the executable
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const welcome = await new Promise((resolve, reject) => {
        ws.on("open", () => ws.send(JSON.stringify({ t: "create", name: "CI" })));
        ws.on("message", m => resolve(JSON.parse(m)));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("no welcome")), 5000);
    });
    if (welcome.t !== "welcome" || !/^[A-Z0-9]{5}$/.test(welcome.room)) throw new Error("bad welcome: " + JSON.stringify(welcome));
    ws.close();

    child.kill();
    await new Promise(r => child.on("exit", r));
    console.log(out.split("\n").slice(0, 4).join("\n"));
    console.log("EXECUTABLE OK:", path.basename(exe));
    process.exit(0);
})().catch(e => {
    console.error("EXECUTABLE CHECK FAILED:", e.message);
    process.exit(1);
});
