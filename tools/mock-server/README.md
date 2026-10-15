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
| `--protocol` | `v1` | Protocol to emulate (see below). |

While it runs, type a command and press Enter:

- `state` prints the device state.
- `drop` cuts every WebSocket connection without a close frame, as if the turntable lost power. Use it to test the UI's reconnect.
- `quit` stops the server.

The log mirrors the firmware's serial output (connects, commands, and `Settings saved` after the 750 ms debounce). It also shows the speed the motor would turn at.

## Protocols

- **`v1`** (`protocol-v1.js`) emulates the v1-format protocol that `code/WebTurntable` speaks until Phase 2. It applies the same validation as `server.cpp` and broadcasts the full state after every command. It follows the current firmware, where CCW is 2. The `v1-esp8266` tag used 3 and logged the UI's CCW as `direction=UNKNOWN`.
- **`v2`** is not written yet. Phase 2 adds `protocol-v2.js` for the [v2 protocol](../../docs/FIRMWARE.md#websocket-protocol-v2-draft) and registers it in `PROTOCOLS` in `mock.js`.

A protocol module exports `createDevice({ broadcast, log })`, which returns `{ onConnect, onMessage, onDisconnect, describe, close }`.

## Files

| File | Purpose |
|---|---|
| `server.js` | Command-line entry: options, startup banner, stdin commands. |
| `mock.js` | HTTP static files plus WebSocket routing; `startMockServer()` is also used by the tests. |
| `websocket.js` | Minimal RFC 6455 server: handshake, masked frames, fragmentation, ping, close. Messages are limited to 64 KB. |
| `protocol-v1.js` | v1 device emulation. |
| `mock.test.js` | Tests. |

## Test

```sh
node --test tools/mock-server/mock.test.js
```

The tests need Node 22.4 or newer, which has a built-in WebSocket client. Tested with Node 22.18.
