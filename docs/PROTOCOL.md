# PROTOCOL.md — Reverse-engineering notes

What the **Monster SoundStage S3** (Qualcomm CUS227, "powered by Qualcomm AllPlay")
exposes on the network, and how this project controls it.

> All findings were obtained by passive/active probing of one unit on a home LAN.
> Everything below is **read-only exploration**; no setting on the speaker was modified.

## Target

| Field | Value |
|---|---|
| Model | SoundStage S3 (S3 Medium Wireless Speaker) |
| Manufacturer | Monster Products |
| Platform | Qualcomm CUS227 1.0, **AllPlay** |
| Firmware | `1.8.29-S/1.3.1/1.2` |
| Hostname | `Qualcomm-Atheros-CUS227-xxxxxx.local` |
| Example IP | `192.168.1.22/24` |

## Open TCP ports

| Port | Service | Notes |
|---|---|---|
| 53 | DNS | dnsmasq-like responder |
| 80 | **LuCI / OpenWRT** | "SoundStage Audio Module" setup UI (`/cgi-bin/luci`) |
| 2870 | **DLNA DMR** | UPnP MediaRenderer (`Server: NFLC/2.3 UPnP/1.0 DLNADOC/1.50`) |
| 8080 | **Spotify Connect** | Spotify zeroConf API |
| 8086 | HTTP (unknown) | responds `404` on all common paths |
| 8087 | — | accepts TCP, no banner (proprietary) |
| 9955 | **AllJoyn bus** | AllPlay control protocol |

## Discovery

- **SSDP** (`M-SEARCH` to `239.255.255.250:1900`): the speaker **does not answer**
  (multicast or unicast). Other DLNA devices on the LAN do. → classic UPnP discovery fails.
- **mDNS**: advertises `_http._tcp` (port 80) and `_spotify-connect._tcp` (port 8080).
  → this is how to locate the speaker automatically.
- **AllJoyn** name service (UDP multicast + `_alljoyn._tcp`).

## Port 80 — setup UI (LuCI / OpenWRT)

The speaker runs **OpenWRT with LuCI**, themed as the **"SoundStage Audio Module"** (`sam`).
No login required on this unit.

- `GET /cgi-bin/luci` → Overview (device name, network, Wi-Fi, "Upgrade Firmware").
- `POST /cgi-bin/luci/config/update_name` (form `friendly_name=…`)
- `POST /cgi-bin/luci/config/update_ap_pass` (`airplay_password_old/new`)
- `GET /cgi-bin/luci/config/status/radio0.network1`
- `GET /cgi-bin/luci/config/setlang?lang=…`
- `GET/POST /cgi-bin/luci/system/upgrade` → flash firmware (`.sam` / `.samu` / `.same`)
- Static assets: `/luci-static/sam/…`, `/luci-static/resources/js/interfacefunctions.js`
- Directory listing is enabled under `/luci-static/…`.
- **No equalizer / tone control page exists** (enumerated 40 candidate pages).

> ⚠️ This is the device OS. Treat as **read-only** unless you know what you're doing.

## Port 2870 — DLNA Digital Media Renderer (the control path used here)

`GET /dmr.xml` returns a standard UPnP device description:

- Device type: `urn:schemas-upnp-org:device:MediaRenderer:1` (DLNA `DMR-1.50`)
- UDN: `uuid:13ee5c76-00c9-101b-8000-ace01076bd28` (per unit)

Services:

| Service | controlURL | SCPD |
|---|---|---|
| `RenderingControl:1` | `/RenderingControl/control` | `/dmr_rcs.xml` |
| `ConnectionManager:1` | `/ConnectionManager/control` | `/dmr_cms.xml` |
| `AVTransport:1` | `/AVTransport/control` | `/dmr_avts.xml` |

Available actions (from the SCPD):

- **RenderingControl**: `GetVolume`, `SetVolume`, `GetMute`, `SetMute`, `GetVolumeDB`,
  `SetVolumeDB`, `ListPresets`, `SelectPreset` (volume range `0..100`, channel `Master`).
- **AVTransport**: `SetAVTransportURI`, `GetMediaInfo`, `GetTransportInfo`,
  `GetPositionInfo`, `Play`, `Pause`, `Stop`, `Seek`, …
- **ConnectionManager**: `GetProtocolInfo`, `GetCurrentConnectionInfo`.

### SOAP example — set volume

```http
POST /RenderingControl/control HTTP/1.1
Host: 192.168.1.22:2870
Content-Type: text/xml; charset="utf-8"
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"

<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>42</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>
```

### SOAP example — cast a stream

`AVTransport:SetAVTransportURI` with the media URL + DIDL-Lite metadata, then `Play`.

```xml
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>Stream</dc:title>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res>http://example.com/stream.mp3</res>
  </item>
</DIDL-Lite>
```

## Port 8080 — Spotify Connect

The speaker registers as a **Spotify Connect** device. Only Spotify playback is
controllable here (no EQ, no input switching).

```
GET http://IP:8080/zeroConf?action=getInfo
{"status":101,"statusString":"OK","version":"2.0.1",
 "deviceID":"090f17f7-…","remoteName":"Soundstage de …","publicKey":"…"}
```

## Port 9955 — AllJoyn (AllPlay control bus)

The "real" AllPlay control protocol is **AllJoyn** over TCP 9955
(also used by the official app, `tchaikovsky` and the openHAB AllPlay binding).
Well-known bus name: `net.allplay.MediaPlayer.<deviceId>`.

Interfaces exposed (extracted from the SDK introspection XML):

- `net.allplay.MediaPlayer` — Play / Pause / Resume / Stop / Next / Previous /
  SetPosition / UpdatePlaylist / GetPlaylist / GetPlayerInfo + props
  `PlayState`, `LoopMode`, `ShuffleMode`, `EnabledControls`.
- `net.allplay.Playlist` — Add / Delete / Move / GetRange / GetRanges / GetHistory.
- `net.allplay.ZoneManager` — `CreateZone` (multiroom grouping).
- `net.allplay.InputSelector` — `InputList`, `ActiveInput`, `SelectInput` (Wi-Fi/BT/AUX/optical).
- `org.alljoyn.Control.Volume` — `Volume`, `Mute`, `AdjustVolume`.
- `net.allplay.MCU` (undocumented) — `PlayItem`, `AdvanceLoopMode`, `ToggleShuffleMode`,
  `GetCurrentItemUrl`, `SetExternalSource`.
- `net.allplay.mcu_system` — `NetworkInfo`, `SystemMode`, `BatteryState`, display name.
- `net.allplay.Firmware` — `Check` / `Update` / `AutoUpdate`.

**No equalizer/tone interface exists** in any of the above.

## What the original app did (verified)

The official app (`com.embience.allplay.soundstage`, v1.3, 2016) was decompiled:
it is a **UPnP/DLNA media browser (Skifta SDK) + AllPlay controller (Qualcomm SDK)**.
A full-text grep for `equaliz|bass|treble|sound mode` over all decompiled code and
resources returns **zero hits**.

👉 The SoundStage S3 has **no network-accessible equalizer**. EQ found in some Monster
apps belongs to other products (soundbars, via "Monster Zone Control 2").

## Summary

| Capability | Path | Status |
|---|---|---|
| Master volume / mute | DLNA 2870 (SOAP) | ✅ used by this app |
| Transport (DLNA source) | DLNA 2870 (SOAP) | ✅ |
| Cast a stream/URL | DLNA 2870 (SOAP) | ✅ |
| Input select / zones / playlist | AllJoyn 9955 | ⚠️ needs AllJoyn (tchaikovsky) |
| Spotify playback | Spotify Connect 8080 | ⚠️ Spotify-only |
| Setup (name, Wi-Fi, AirPlay, firmware) | LuCI 80 | ✅ |
| **Equalizer** | — | ❌ does not exist |
