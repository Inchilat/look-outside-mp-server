// Minimal UPnP IGD client: asks the home router to forward a TCP port to this PC.
// Many routers support it (sometimes it must be enabled in the router settings).
// No dependencies: SSDP discovery over UDP multicast + SOAP over HTTP.
const dgram = require("dgram");
const http = require("http");
const { URL } = require("url");

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const SERVICE_TYPES = [
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

// SSDP: returns the LOCATION urls of the gateways that answered
function discover(timeoutMs = 3000) {
    return new Promise(resolve => {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const found = new Set();
        const finish = () => {
            try {
                socket.close();
            } catch {
                /* already closed */
            }
            resolve([...found]);
        };
        socket.on("message", msg => {
            const m = String(msg).match(/^location:\s*(.+)$/im);
            if (m) found.add(m[1].trim());
        });
        socket.on("error", finish);
        socket.bind(0, () => {
            for (const st of SEARCH_TARGETS) {
                const req = Buffer.from(
                    `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
                );
                socket.send(req, SSDP_PORT, SSDP_ADDRESS);
            }
        });
        setTimeout(finish, timeoutMs);
    });
}

function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
            { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, timeout: timeoutMs },
            res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", c => (data += c));
                res.on("end", () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// device description -> { controlUrl, serviceType }
async function findService(location) {
    const { body } = await request(location);
    const base = (body.match(/<URLBase>\s*([^<]+?)\s*<\/URLBase>/i) || [])[1] || location;
    for (const type of SERVICE_TYPES) {
        const re = new RegExp(`<service>(?:(?!</service>)[\\s\\S])*?<serviceType>\\s*${type.replace(/[.:]/g, "\\$&")}\\s*</serviceType>(?:(?!</service>)[\\s\\S])*?</service>`, "i");
        const block = (body.match(re) || [])[0];
        if (!block) continue;
        const control = (block.match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i) || [])[1];
        if (control) return { controlUrl: new URL(control, base).toString(), serviceType: type };
    }
    return null;
}

async function soap(service, action, args = {}) {
    const params = Object.entries(args)
        .map(([k, v]) => `<${k}>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${k}>`)
        .join("");
    const body =
        `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="${service.serviceType}">${params}</u:${action}></s:Body></s:Envelope>`;
    const res = await request(service.controlUrl, {
        method: "POST",
        headers: {
            "Content-Type": 'text/xml; charset="utf-8"',
            "Content-Length": Buffer.byteLength(body),
            SOAPAction: `"${service.serviceType}#${action}"`,
        },
        body,
    });
    if (res.status !== 200) {
        const code = (res.body.match(/<errorCode>(\d+)<\/errorCode>/) || [])[1];
        const desc = (res.body.match(/<errorDescription>([^<]*)<\/errorDescription>/) || [])[1];
        throw new Error(`${action} failed (HTTP ${res.status}${code ? `, UPnP error ${code}` : ""}${desc ? `: ${desc}` : ""})`);
    }
    return res.body;
}

// local address the router sees for this PC
function localAddressFor(host) {
    return new Promise(resolve => {
        const s = dgram.createSocket("udp4");
        s.on("error", () => resolve(null));
        s.connect(9, host, () => {
            const a = s.address().address;
            s.close();
            resolve(a);
        });
    });
}

// Opens `port` (TCP) on the router towards this PC.
// Returns { externalIp, internalIp, gateway, lease } or throws with a readable message.
// options.locations: device description urls (skips discovery; used by the tests)
async function openPort(port, description = "Look Outside MP", options = {}) {
    const locations = options.locations || (await discover());
    if (!locations.length) throw new Error("No UPnP router found (UPnP may be disabled in the router settings)");
    let lastError = null;
    for (const location of locations) {
        try {
            const service = await findService(location);
            if (!service) continue;
            const internalIp = await localAddressFor(new URL(service.controlUrl).hostname);
            let lease = 0;
            const add = seconds =>
                soap(service, "AddPortMapping", {
                    NewRemoteHost: "",
                    NewExternalPort: port,
                    NewProtocol: "TCP",
                    NewInternalPort: port,
                    NewInternalClient: internalIp,
                    NewEnabled: 1,
                    NewPortMappingDescription: description,
                    NewLeaseDuration: seconds,
                });
            try {
                await add(0); // permanent until removed
            } catch (e) {
                lease = 7200; // some routers only accept leases with an expiry
                await add(lease);
            }
            let externalIp = null;
            try {
                externalIp = (soapValue(await soap(service, "GetExternalIPAddress"), "NewExternalIPAddress") || "").trim() || null;
            } catch {
                /* not essential */
            }
            return { service, externalIp, internalIp, gateway: new URL(service.controlUrl).hostname, lease, port };
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error("The router doesn't offer port forwarding through UPnP");
}

async function closePort(mapping) {
    if (!mapping) return;
    await soap(mapping.service, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: mapping.port, NewProtocol: "TCP" });
}

function soapValue(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
}

module.exports = { openPort, closePort, discover, findService };
