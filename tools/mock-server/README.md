# Mock turntable server

Serves the web UI from `code/WebTurntable/data/` and fakes the firmware's WebSocket at `/ws`, so the UI can be built and tested in a browser without hardware. It uses only Node built-ins, so there is nothing to install.

## Run

```sh
node tools/mock-server/server.js            # http://127.0.0.1:8080/
node tools/mock-server/server.js --help     # all options
```

| Option | Default | Notes |
|---|---|---|
| `-p, --port` | `8080` | |
| `--host` | `127.0.0.1` | Use `0.0.0.0` to open the UI from a phone on the same network. Windows may ask to allow Node through the firewall. |
| `--data` | `code/WebTurntable/data` | Folder to serve. Files are read on every request, so edits show on reload. |
| `--protocol` | `v2` | Protocol to emulate (see below). |

While it runs, type a command and press Enter:

- `state` prints the device state.
- `drop` cuts every WebSocket connection without a close frame, as if the turntable lost power. Use it to test the UI's reconnect.
- `quit` stops the server.

The log mirrors the firmware's serial output (connects, commands, and `Settings saved` after the 750 ms debounce). It also shows the speed the motor would turn at.

## Protocols

- **`v2`** (`protocol-v2.js`) emulates the [v2 protocol](../../docs/FIRMWARE.md#websocket-protocol-v2). It parses and validates commands the way `server.cpp` does, and simulates the motion engine with the same ramp, braking and move-target logic as `motion.cpp`, ticking every 10 ms. It broadcasts state after each command and 10 times a second while the disk moves, and logs `Settings saved` once the disk is idle, as the firmware does.
- The v1 protocol (`protocol-v1.js`) was removed in Phase 2 along with the v1 UI; it's in the git history.

A protocol module exports `createDevice({ broadcast, log })`, which returns `{ onConnect, onMessage, onDisconnect, describe, close }`.

## Files

| File | Purpose |
|---|---|
| `server.js` | Command-line entry: options, startup banner, stdin commands. |
| `mock.js` | HTTP static files plus WebSocket routing; `startMockServer()` is also used by the tests. |
| `websocket.js` | Minimal RFC 6455 server: handshake, masked frames, fragmentation, ping, close. Messages are limited to 64 KB. |
| `protocol-v2.js` | v2 device emulation, including the simulated motion engine. |
| `mock.test.js` | Tests. |

## Test

```sh
node --test tools/mock-server/mock.test.js
```

The tests need Node 22.4 or newer, which has a built-in WebSocket client. Tested with Node 22.18.
