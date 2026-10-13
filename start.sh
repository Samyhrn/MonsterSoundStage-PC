#!/usr/bin/env bash
# SoundStage PC — launcher (macOS / Linux)
cd "$(dirname "$0")"
( sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:8099 || open http://localhost:8099 ) >/dev/null 2>&1 &
exec node server.js "$@"
