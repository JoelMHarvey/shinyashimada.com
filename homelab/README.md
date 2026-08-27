# Balcony camera relay

The Tapo camera speaks RTSP on your home network. A browser on the internet
can do nothing with either of those facts, so this is the piece in between:
a small always-on relay that pulls RTSP from the camera and republishes it
over HTTPS, reachable through a Cloudflare tunnel.

```
Tapo camera ──RTSP──▶ go2rtc ──HTTP/WS──▶ cloudflared ──▶ Cloudflare ──▶ browser
 192.168.1.x          (this machine)        outbound only
```

## Why not just embed the camera's address

Two separate blockers, and fixing one does not fix the other:

- **`192.168.1.x` is a private address.** It exists only on your LAN. A phone
  on mobile data has no route to it at all.
- **Browsers do not play RTSP.** Even on the same network, `rtsp://…` in a
  `<video>` tag does nothing. It has to be repackaged.

## Setup

**1. Turn on RTSP.** In the Tapo app: Device Settings → Advanced Settings →
Camera Account. Create a username and password. This is a camera-local
account, not your TP-Link cloud login. Note the camera's IP from Network
Settings — set a static one, as you have, or it will move and break this.

**2. Configure and start the relay.**

```bash
cd homelab
cp .env.example .env      # fill in CAMERA_IP / CAMERA_USER / CAMERA_PASS
docker compose up -d go2rtc
```

Check it locally at `http://localhost:1984` — the balcony stream should be
listed and playable. If not, nothing downstream will work, so fix it here.

**3. Create a Cloudflare tunnel.** In the Cloudflare Zero Trust dashboard:
Networks → Tunnels → Create a tunnel. Add a public hostname pointing at
`http://localhost:1984`, copy the tunnel token into `.env` as `TUNNEL_TOKEN`,
then:

```bash
docker compose up -d
```

No router ports are forwarded; `cloudflared` dials out.

**4. Point the site at it.** In Netlify, set:

```
CAMERA_STREAM_URL = https://<your-hostname>/stream.html?src=balcony&mode=mse
CAMERA_LABEL      = Balcony            # optional, shown as the card title
```

Then redeploy — environment changes do not reach functions already running.

## Use `mode=mse`, not WebRTC

go2rtc prefers WebRTC, and over a LAN you should. **Through a Cloudflare
tunnel you should not.** The tunnel carries HTTP and WebSockets; WebRTC wants
its own UDP media path, which the tunnel does not forward. Left to default,
the player spends several seconds attempting WebRTC, failing, and only then
falling back — so ask for MSE directly.

MSE runs over the WebSocket the tunnel already carries, at roughly a second
of latency. For a fixed shot of some plants that is indistinguishable from
instant.

## What this protects, and what it does not

**The tunnel hostname is publicly reachable.** The site only hands the URL to
someone holding the passcode, which narrows who learns it — but anyone who
*does* learn it can open the stream directly, without the site.

For a balcony of plants that may be a fair trade, and it is the reason this
was worth building at all. It would not be a fair trade for a camera indoors.

If the stream itself must be authenticated, put **Cloudflare Access** in front
of the hostname. Be aware of the consequence: an Access login page cannot be
embedded in an iframe, so the site would have to link out to the stream in a
new tab rather than showing it inline. That is a real trade-off between
convenience and control, not a setting to flip without thinking.

Two smaller things worth doing either way:

- Use `stream2` (360p), as configured. A home upstream connection is the
  bottleneck, and it is a fixed shot of some pots.
- Keep `.env` out of git. It is already ignored, and it holds both the camera
  credentials and a token that routes into your network.

## If it stops working

- **Card says the camera is offline** — the relay is down or this machine is
  asleep. `docker compose ps`, then `docker compose logs go2rtc`.
- **Stream lists but will not play** — usually the RTSP credentials, or the
  camera's IP moved. Check `http://localhost:1984` first; if it fails there,
  nothing beyond it can work.
- **Works at home, not away** — the tunnel. `docker compose logs cloudflared`.
- **Long delay before the picture appears** — the player is probably still
  trying WebRTC. Confirm `&mode=mse` is on the URL.
