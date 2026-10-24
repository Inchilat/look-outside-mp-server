# Running the server

Every game needs a **room server**: a small relay the players connect to. It doesn't know the game rules and
stores nothing; the player who creates a room (the host) is the authority on the game state.

Pick one of the three ways below. Whatever you choose, the players type the server address in the
**Server address** field of the in-game panel (**F6**), e.g. `192.168.1.20`, and the port (default **8787**) in **Port**.

| | Who it's for | Friends over the Internet |
|---|---|---|
| [A. Host app on your PC](#a-host-app-on-your-pc) | Anyone. One click, nothing to install | Router port (automatic with UPnP) or a VPN like Tailscale |
| [B. Docker on a VPS](#b-docker-on-a-vps) | You already have a Linux server | Works out of the box (open the port in the firewall) |
| [C. Node.js from the sources](#c-nodejs-from-the-sources) | Developers | Same as A |

The server uses one TCP port, **8787** by default. A server can run several rooms (games), up to 4 players each.

---

## A. Host app on your PC

1. Download the zip for your system from the [Releases](../../releases) page and unzip it:
   - Windows: `look-outside-mp-host-windows-x64.exe`
   - macOS (Apple Silicon): `look-outside-mp-host-macos-arm64`
   - Linux: `look-outside-mp-host-linux-x64`
2. Start it. A console window opens (keep it open while you play) and the **control page** opens in your browser.
   - Windows: if SmartScreen says "Windows protected your PC", click *More info → Run anyway* (the app isn't signed).
     When the firewall asks, allow **Private** networks (and **Public** if your friends connect over the Internet
     and Windows marked your network as public).
   - macOS: the first time, right click the file → *Open* → *Open* (it isn't signed by Apple). If macOS still refuses:
     `xattr -d com.apple.quarantine look-outside-mp-host-macos-arm64` in the Terminal.
   - Linux: `chmod +x look-outside-mp-host-linux-x64 && ./look-outside-mp-host-linux-x64`
3. On the control page:
   - **Addresses for the players** — the address for each situation, with a *Copy* button:

     | Your friends are... | They use | Needs |
     |---|---|---|
     | on your PC (you) | `localhost` | nothing |
     | on your home network | the *Same network (LAN)* address, e.g. `192.168.1.20` | nothing |
     | on the Internet | the *Internet* address (button *Find my Internet address*) | the router port open (see below) |
     | on the same Tailscale / ZeroTier / Radmin VPN / Hamachi network | that network's address | nothing |

4. Start the game, press **F6**, write your name, keep `localhost` as server address and `8787` as port, and click
   **Host** (room name and an optional password). Give your friends the address from the table above; they write it
   with the same port and pick your room from the list that appears next to the panel.

Close the console window (or press Ctrl+C) to stop the server.

### Opening the port for friends on the Internet

- **Automatic (UPnP)**: on by default. The control page says *Port 8787 forwarded to ... by the router* when it worked.
  The port is closed again when you quit. If it says *No UPnP router found*, UPnP is off in your router settings
  (often under *Advanced → UPnP*) or your provider doesn't allow it.
- **By hand**: in your router settings, forward **TCP port 8787** to your PC's local address (the *Same network*
  address on the control page). Search "port forwarding" + your router model for the exact menu.
- **No router access / CGNAT** (the Internet address on the control page differs from the WAN address shown in your
  router, or starts with 100.64–100.127): port forwarding can't work. Use a VPN like
  [Tailscale](https://tailscale.com/) (free, everybody installs it and joins the same network) and give your
  friends your Tailscale address, or use a VPS (B).

### Options

```
look-outside-mp-host --port 9000      # another port (also from the control page: "Server port")
look-outside-mp-host --no-upnp        # never touch the router
look-outside-mp-host --no-browser     # don't open the control page automatically
```

Settings (port, UPnP) are saved in `~/.look-outside-mp.json` (`C:\Users\<you>\.look-outside-mp.json` on Windows).

Everyone who plays (you too) needs the mod in their game: see the installation instructions on the mod's Nexus Mods page.

---

## B. Docker on a VPS

On a Linux server with Docker and the Compose plugin:

```bash
git clone https://github.com/<you>/look-outside-mp.git
cd look-outside-mp/host/server
docker compose up -d --build
curl http://localhost:8787          # -> look-outside-mp ok - rooms: 0
```

Open the port if the server has a firewall:

```bash
sudo ufw allow 8787/tcp             # ufw
# or in your provider's control panel (security group / firewall rules)
```

Players use the server IP as address and `8787` as port. To update: `git pull && docker compose up -d --build` in the same folder.
Logs: `docker compose logs -f`. Another port: change `"8787:8787"` in `docker-compose.yml` to `"9000:8787"`.

### Secure connection (optional, wss://)

If the server has a domain name you can put it behind a reverse proxy with HTTPS and use `wss://`.
Example with [Caddy](https://caddyserver.com/) (it gets the certificate by itself):

```
mp.example.com {
    reverse_proxy localhost:8787
}
```

Players then write `wss://mp.example.com` as server address and leave the port empty.

---

## C. Node.js from the sources

Needs [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/<you>/look-outside-mp.git
cd look-outside-mp
npm install
npm run host                        # host app: server + control page (same as A)
# or only the room server, no control page:
node host/server/server.js          # PORT=9000 node host/server/server.js for another port
```

To build the single executable yourself: `npm run build:app` (creates `build/look-outside-mp-host-<system>`;
it embeds the Node.js you run it with, version 22 recommended).

---

## Troubleshooting

| Problem | What to check |
|---|---|
| *Server unreachable* in the F6 panel | Address and port are right; the app/server is running; the firewall allows the port; for Internet players, the router port is forwarded (or use a VPN). From the friend's PC, open `http://<address>:8787` in a browser: it must say `look-outside-mp ok`. |
| *No rooms open* in the room list | The host must press **Host** first. A room closes when its host leaves. |
| *Wrong password* / *This room needs a password* | Ask the host for the room password (rooms with a lock in the list have one). |
| *Room is full* | 4 players at most. |
| *Port 8787 is already in use* | Another copy of the app (or the Docker server) is running, or pick another port. |
| UPnP fails | See *Opening the port* above; everything else still works on the local network and with VPNs. |
| Friends see *waiting for the host* | The host must be in game (past the title screen and the intro, no dialog open): the game is sent automatically. |
