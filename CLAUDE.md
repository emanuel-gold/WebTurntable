# CLAUDE.md

## Project

WebTurntable is a small motorized turntable (100 mm disk, 28BYJ-48 stepper, ULN2003 driver) controlled from a phone browser. The microcontroller joins the user's Wi-Fi and serves a web UI at `http://turntable.local` (mDNS). Setup runs over an open access point (`TURNTABLE`, 192.168.4.5) with a captive page, which also serves as an access-point fallback. The UI talks to the firmware over a WebSocket. The enclosure is FDM-printed in PLA; STLs are in `STL/`, and the originals are on MakerWorld (model 572900).

This repo is a fork:

- `upstream` (raceking37/WebTurntable) is the original project, including the README text and the v1 design.
- `origin` (emanuel-gold/WebTurntable) is this fork, which carries the v2 work.

Push to `origin` only when the user asks. Never push or open PRs against `upstream`.

Work directly on main (renamed from master); there are no feature branches. v1 (ESP8266, Wemos D1 mini) is frozen at tag `v1-esp8266` and isn't maintained. Check out the tag to build it.

**Current state:** Phase 1 is done and confirmed on hardware. Phase 2 (motion engine, protocol v2, new UI) and Phase W (home Wi-Fi with captive-portal setup) are code-complete and tested against the mock, and waiting on the user's hardware test.

**In progress:** v2 for an ESP32 DevKit V1, adding timer-driven motion with ramps, angle control, back-and-forth mode, timers, presets, a Bluetooth camera shutter, and new enclosure parts.

## Starting a session

1. Run `git pull` and check `git status`.
2. Read the **Status** section of [docs/ROADMAP.md](docs/ROADMAP.md). It says what is done and what comes next.
3. If the next task depends on an unanswered roadmap open question, ask the user first.

As work lands, tick roadmap checkboxes, update its Status section, and record decisions in its Decisions table.

## Layout

- `code/Basic/`: minimal sketch that only spins the motor and lights the LED (no Wi-Fi). It's a wiring test, with its own `sketch.yaml` that has to stay in step with the main one.
- `code/WebTurntable/`: the full firmware (an Arduino sketch folder).
  - `WebTurntable.ino`: `setup()` and `loop()`.
  - `config.h`: pins, motor constants, and speed and acceleration limits.
  - `motion.{h,cpp}`: the motion engine. A GPTimer ISR steps the coils through the GPIO registers, and a 1 kHz ramp task on core 1 sets its interval. Position is in half-steps, positive clockwise. See [FIRMWARE.md](docs/FIRMWARE.md#motion-engine).
  - `server.{h,cpp}`: AsyncWebServer with the WebSocket at `/ws` (protocol v2), and settings persistence (NVS via `Preferences`).
    - The AsyncTCP task only parses and validates JSON. Commands are queued and run in `loop()`, so settings are single-threaded.
    - Saves wait for the motor to be idle, because flash writes pause the step interrupt.
  - `wireless.{h,cpp}`: the Wi-Fi state machine. It joins the saved network, or starts the setup access point with captive DNS. It also runs the setup page's `/api/wifi/*`, mDNS, and the reset button on GPIO 22. See [FIRMWARE.md](docs/FIRMWARE.md#wi-fi-and-setup-phase-w-wirelesscpp).
  - `data/`: the web UI served from LittleFS: the control page (`index.html`, `script.js`), the Wi-Fi setup page (`setup.html`, `setup.js`), and the shared `style.css` and `favicon.png`. Vanilla JS, no build step.
  - `sketch.yaml`: arduino-cli build profile `esp32` that pins the v2 core and library versions.
- `STL/`: body, bottom plate, and `top plate` (which is the disk).
- `docs/`: roadmap plus design and reference docs:
  - [ROADMAP.md](docs/ROADMAP.md): phases, MVP scope, backlog, decisions, open questions.
  - [FIRMWARE.md](docs/FIRMWARE.md): v2 architecture, motion engine, WebSocket protocol draft.
  - [HARDWARE.md](docs/HARDWARE.md): v2 parts, ESP32 pin map, wiring, power.
  - [ENCLOSURE.md](docs/ENCLOSURE.md): measured geometry of the current STLs and the v2 enclosure design.
  - [FLASHING.md](docs/FLASHING.md): step-by-step flashing for the user, plus troubleshooting.
- `tools/flash.cmd` and `tools/flash.ps1`: compile and flash v2 (firmware, web UI, serial monitor) with arduino-cli. The `.cmd` wrapper bypasses the PowerShell execution policy.
- `tools/stl_inspect.py`: numpy-only STL inspector (bounding boxes, hole finder, wall openings, PNG cross-sections).
- `tools/mock-server/`: dependency-free Node server that serves `data/` and emulates the firmware's WebSocket, for UI work without hardware ([README](tools/mock-server/README.md)).

## Build and flash

**v1 (ESP8266, tag `v1-esp8266`):**

- Arduino IDE 2.x with the ESP8266 core.
- Board "LOLIN(WEMOS) D1 R2 & mini", Flash Size "4MB (FS:3MB OTA:~512KB)".
- Libraries: ESPAsyncWebServer and ESPAsyncTCP (ESP32Async), and Arduino_JSON.
- Upload `data/` with the arduino-littlefs-upload plugin.

**v2 (ESP32):** see the Toolchain section of [docs/FIRMWARE.md](docs/FIRMWARE.md#toolchain). Versions are pinned in `code/WebTurntable/sketch.yaml`. Flash with `tools\flash.cmd` ([docs/FLASHING.md](docs/FLASHING.md)), not the Arduino IDE.

**Compiling and flashing:**

- Compile-check before asking the user to flash: `tools\flash.cmd check`, or `arduino-cli compile --profile esp32 code/WebTurntable`.
- The script finds arduino-cli on PATH or bundled with Arduino IDE 2, usually at `<IDE install dir>\resources\app\lib\backend\resources\arduino-cli.exe`.
- `-WhatIf` compiles and builds the web UI image without writing to a board. Use it to test the script.
- Ask before uploading to a connected board.
- The current DevKit only enters download mode while the user holds BOOT ([HARDWARE.md](docs/HARDWARE.md#download-mode-and-the-boot-button)), so an upload can't run unattended. Either the user runs `tools\flash.cmd` and holds BOOT, or they hold it while you run the command.
- If flashing steps change, update [docs/FLASHING.md](docs/FLASHING.md). The user wants it easy to follow.
- The user does hardware testing (motor behavior, phone pairing). Don't claim a change works on the device until the user confirms it.
- Write testing steps for the user in `todo_checks.md` at the repo root. It's gitignored, so create it if it's missing.
  - Start to-do items with `- [ ]` checkboxes.
  - Remove items the user reports as done.

## Environment

- Windows 11, with the Arduino tooling and Blender installed. Executables may not be on PATH: the Arduino IDE (2.2.1) is under `%LOCALAPPDATA%\Programs\Arduino IDE` and Blender under `C:\Program Files\Blender Foundation\`.
- The mock server's tests need Node 22.4 or newer, for the built-in WebSocket client.
- **STL tools:**
  - Use `python tools/stl_inspect.py` (needs only numpy) to measure STLs and render cross-sections to PNG, then view the PNGs.
  - Use `manifold3d` for mesh booleans. All three original STLs are watertight. Install it in a `.venv`, not globally.
  - Generate enclosure parts with Python scripts so they rebuild from source. Use Blender for visual checks; it also runs headless (`blender --background --python script.py`) to render previews.
- STL frame: origin at the top-center of the body deck, +Z up, in mm. The body spans z −21.5 to 0, the disk z 0 to 9.5, and the bottom plate z −23.5 to −21.

## Conventions

- Arduino C++ style:
  - Allman braces.
  - File-local helpers in an anonymous namespace.
  - Globals prefixed `g_`.
  - A one-line `//` comment above each function.
  - Indentation: tabs in `server.cpp`, 4 spaces elsewhere. Match the file you are editing.
- Web UI stays dependency-free: no frameworks and no CDN, because the phone has no internet while it is on the turntable's AP.
- Keep the flash-wear guard: persist settings only after an idle delay, never on every change.

## Known issues

- **Not measured yet:** the max reliable speed and the real steps per revolution (Phase 2 hardware checks). Until then, `DEFAULT_MAX_RPM` is 15 and `HALF_STEPS_PER_REV` is the datasheet value.
- **Fixed in Phase 1, still present at the `v1-esp8266` tag:** the UI sends `2` for CCW, but v1's `RotateDirection::CCW` was `3`. CCW still worked, because any value other than CW steps CCW, but the logs showed `direction=UNKNOWN`.
