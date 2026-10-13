# Architecture

## Overview

```
┌──────────────┐   HTTP (localhost:8099)   ┌────────────────────────┐   DLNA/SOAP    ┌──────────────────┐
│   Browser    │ ────────────────────────▶ │   Node server (0 deps) │ ─────────────▶ │  Speaker :2870   │
│  (the UI)    │ ◀──────────────────────── │  discovery + control   │ ◀───────────── │  (MediaRenderer) │
└──────────────┘       JSON / static       └────────────────────────┘    XML/SOAP     └──────────────────┘
```

The browser only talks to `localhost`. All LAN discovery and SOAP traffic is done by the local
Node server — this sidesteps the browser's inability to do UDP multicast (SSDP) and the
speaker's lack of CORS headers.

## Why not a pure static web page?

- **Discovery** needs **SSDP** (UDP multicast to `239.255.255.250:1900`) or a **unicast scan** —
  impossible from JavaScript in a browser.
- **Control** is **UPnP/SOAP** (HTTP POST of an XML envelope) to the speaker. Browsers block
  the response because the speaker sends no CORS headers.

A ~900-line zero-dependency Node server solves both and serves the UI.

## Components

### `server.js` (single file, zero dependencies)

- **`ssdpProbe()`** — multi-interface `M-SEARCH` over UDP; collects raw responses and parses
  device descriptions (though the S3 doesn't answer SSDP itself).
- **`mdnsProbe()`** — minimal mDNS resolver (custom DNS message parser) querying common service
  types (`_spotify-connect`, `_googlecast`, `_airplay`, `_services._dns-sd._udp`, …). Used to
  *identify* the speaker and its capabilities.
- **`rawHttpGet()` / `rawHttpPost()`** — HTTP over a raw TCP socket. Tolerates the speaker's
  broken `Content-Length` header (which makes Node's `fetch` throw `HPE_UNEXPECTED_CONTENT_LENGTH`).
- **`dlnaCall()`** — sends UPnP **SOAP** requests to the DLNA renderer on port **2870**
  (`RenderingControl` for volume/mute, `AVTransport` for transport/cast).
- **`scanSubnet()` / `portScan()` / `probeDevice()` / `describePort()` / `enumeratePages()` /
  `allplayHunt()`** — the "Advanced" recon toolbox (unicast scans, port sweep, UPnP describe,
  banner grabbing).
- **HTTP API** (all JSON) — see the table below. Serves `public/` as static files.

### `public/index.html` (single file, zero dependencies)

- Dark "hi-fi" theme, glassmorphism, gradient accents.
- **Circular volume knob** (SVG arc, drag vertically; pointer + touch).
- Transport buttons, mute, now-playing (title + animated bars).
- Cast-a-stream input.
- **Inline SVG icon set** (no emoji → renders identically everywhere, no emoji font needed).
- `#demo` hash renders the UI with demo data (for screenshots/docs).

## HTTP API

| Method | Endpoint | Body / query | Returns |
|---|---|---|---|
| GET | `/api/discover` | — | `{ devices, raw }` (SSDP) |
| GET | `/api/scan` | — | `{ devices }` (unicast subnet scan) |
| POST | `/api/add` | `{ ip, port? }` | `{ device }` |
| GET | `/api/list` | — | `{ devices }` |
| POST | `/api/dlna` | `{ ip, port, service, action, args }` | `{ ok, volume?, mute?, transportState?, raw }` |
| GET | `/api/diagnose` | `?ip` | interfaces + raw SSDP + mDNS |
| GET | `/api/probe` | `?ip` | open ports + HTTP fingerprint + unicast SSDP |
| GET | `/api/describe` | `?ip&port` | candidate UPnP description paths |
| GET | `/api/enumerate` | `?ip` | LuCI page enumeration |
| GET | `/api/recon` | `?ip` | deep port scan + theme assets |
| GET | `/api/services` | `?ip` | banner grab of AllPlay ports |
| GET | `/api/allplay` | `?ip` | SCPD files + extra ports |
| GET | `/api/fetch` | `?ip&port&path` | raw HTTP GET (tolerant client) |

`service` is `RenderingControl` or `AVTransport`; `args` is the inner SOAP argument XML.

## Control model

Everything user-facing is **DLNA/UPnP** against port **2870**:

- **Volume / mute** → `RenderingControl` (`GetVolume`, `SetVolume`, `GetMute`, `SetMute`).
- **Transport** → `AVTransport` (`Play`, `Pause`, `Stop`, `Previous`).
- **Cast** → `AVTransport.SetAVTransportURI` (a DIDL-Lite metadata blob wrapping the audio URL)
  followed by `Play`.

There is **no equalizer** exposed anywhere on the device (see `PROTOCOL.md`).

## Portability

- Pure Node built-ins (`http`, `dgram`, `net`, `os`, `fs`, `path`) — **no `npm install`**.
- Runs on Windows 11, macOS and Linux. Windows: `start.bat`; Unix: `start.sh`.
- Optionally package as a single `.exe` with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg).
