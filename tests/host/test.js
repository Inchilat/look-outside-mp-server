// Host app tests: UPnP against a fake router and the app itself (room server + control page API).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const upnp = require("../../host/app/upnp");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lomp-test-"));
// fake router: device description + WANIPConnection control endpoint
function fakeRouter() {
    const calls = [];
    const server = http.createServer((req, res) => {
        if (req.url === "/desc.xml") {
            res.writeHead(200, { "Content-Type": "text/xml" });
            return res.end(`<?xml version="1.0"?><root><device><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
</serviceList></device></deviceList></device></root>`);
        }
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
            const action = (req.headers.soapaction || "").replace(/"/g, "").split("#")[1];
            calls.push({ action, body });
            if (action === "AddPortMapping" && /<NewLeaseDuration>0</.test(body)) {
                res.writeHead(500);
                return res.end("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
            }
            res.writeHead(200, { "Content-Type": "text/xml" });
            if (action === "GetExternalIPAddress") return res.end("<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>");
            res.end("<s:Envelope><s:Body/></s:Envelope>");
        });
    });
    return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}/desc.xml` })));
}

async function testUpnp() {
    const router = await fakeRouter();
    const m = await upnp.openPort(8787, "Look Outside MP", { locations: [router.url] });
    assert.equal(m.externalIp, "203.0.113.7");
    assert.equal(m.lease, 7200, "falls back to a lease when the router refuses permanent mappings");
    const add = router.calls.filter(c => c.action === "AddPortMapping");
    assert.equal(add.length, 2);
    assert.match(add[1].body, /<NewExternalPort>8787<\/NewExternalPort>/);
    assert.match(add[1].body, /<NewInternalClient>127\.0\.0\.1<\/NewInternalClient>/);
    await upnp.closePort(m);
    assert.equal(router.calls.at(-1).action, "DeletePortMapping");
    router.server.close();
    console.log("upnp: ok");
}

async function testApp() {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const child = spawn(process.execPath, [path.join(__dirname, "../../host/app/main.js"), "--no-browser", "--no-upnp", "--port", "18790", "--dashboard-port", "0"], {
        env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    const link = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("app did not start:\n" + output)), 8000);
        const i = setInterval(() => {
            const m = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
            if (m) {
                clearInterval(i);
                clearTimeout(t);
                resolve(m[0]);
            }
        }, 50);
    });
    const u = new URL(link);
    const token = u.searchParams.get("t");
    const req = (method, p, body, headers = {}) =>
        new Promise((resolve, reject) => {
            const r = http.request({ host: "127.0.0.1", port: u.port, path: p, method, headers: Object.assign({ "Content-Type": "application/json" }, headers) }, res => {
                let data = "";
                res.on("data", c => (data += c));
                res.on("end", () => resolve({ status: res.statusCode, data }));
            });
            r.on("error", reject);
            if (body) r.write(JSON.stringify(body));
            r.end();
        });
    // control page: only with the token
    assert.equal((await req("GET", "/")).status, 403);
    const page = await req("GET", "/?t=" + token);
    assert.equal(page.status, 200);
    assert.ok(page.data.includes(`const TOKEN = "${token}"`));
    assert.equal((await req("GET", "/api/status")).status, 403);
    const st = JSON.parse((await req("GET", "/api/status", null, { "X-Token": token })).data);
    assert.equal(st.port, 18790);
    assert.equal(st.upnp.enabled, false);
    // the room server answers
    const health = await new Promise(r => http.get("http://127.0.0.1:18790/", res => { let d = ""; res.on("data", c => (d += c)); res.on("end", () => r(d)); }));
    assert.match(health, /look-outside-mp ok/);
    // the app doesn't install the mod any more
    assert.equal((await req("POST", "/api/install", { gameDir: tmp }, { "X-Token": token })).status, 404);
    // another site's page can't drive it (Host check)
    assert.equal((await req("GET", "/api/status", null, { "X-Token": token, Host: "evil.example" })).status, 403);
    child.kill("SIGTERM");
    await new Promise(r => child.on("exit", r));
    console.log("host app: ok");
}

(async () => {
    await testUpnp();
    await testApp();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("APP TEST OK");
})().catch(e => {
    console.error("TEST FAILED", e);
    process.exit(1);
});
