# Contributing

Thanks for your interest! This is a small, dependency-free project — contributions are welcome.

## Ground rules

- **No runtime dependencies.** The whole point is a single `node server.js` with zero `npm install`.
  Please keep it that way (Node built-ins only).
- **Keep the UI single-file.** The web UI lives entirely in `public/index.html` (inline CSS/JS,
  inline SVG icons). No external assets, no CDNs.
- **Don't commit device IPs / personal data.**

## Getting started

```bash
git clone <your-fork>
cd MonsterSoundStage-PC
node server.js            # -> http://localhost:8099
# UI preview without hardware:
#   http://localhost:8099/#demo
```

## Before opening a PR

- `node -c server.js` should pass.
- If you touch `public/index.html`, make sure the inline script still parses
  (open the console; syntax errors show up there).
- Describe what you changed and, if relevant, the hardware/firmware you tested on
  (model, AllPlay firmware version).

## Ideas / roadmap

- Multi-room / zones (AllJoyn `net.allplay.ZoneManager` on port 9955).
- Input selection (WiFi / Bluetooth / AUX / Optical) via `net.allplay.InputSelector`.
- Now-playing metadata (cover art) via `AVTransport.GetPositionInfo`.
- Optional light theme.

## License

By contributing, you agree your contributions are released under **The Unlicense** (public domain).
