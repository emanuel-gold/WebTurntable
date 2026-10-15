# Firmware v2 design (ESP32)

This describes the target firmware, not the current code. The v1 code is summarized in [CLAUDE.md](../CLAUDE.md). Update this doc when implementation changes the design.

## Toolchain

- Arduino IDE 2.x or arduino-cli, with the ESP32 Arduino core 3.x.
- Board: "ESP32 Dev Module" (`esp32:esp32:esp32`). It has the full set of board menus; the "DOIT ESP32 DEVKIT V1" entry has fewer.
- Partition scheme: **Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS)** (`PartitionScheme=min_spiffs`).
  - Wi-Fi, Bluetooth and the web server together are likely too big for the default 1.25 MB app slot.
  - This scheme also gives the two app slots that OTA needs (Phase 5).
  - In core 3.x the file system partition is 128 KB (`0x20000`), because the scheme now also reserves a 64 KB coredump partition. Older docs and labels say 190 KB. 128 KB is still enough for the web UI (about 21 KB now) and presets. If the v2 UI outgrows it, serve gzipped assets (AsyncWebServer picks up `.gz` files automatically) or add a custom `partitions.csv` to the sketch folder. LittleFS uses this "spiffs" partition by default.
- Libraries:
  - ESPAsyncWebServer and AsyncTCP (both from ESP32Async; Library Manager names "ESP Async WebServer" and "Async TCP"). Several forks share these names, so check the author.
  - ArduinoJson 7, replacing Arduino_JSON because presets need nested objects.
  - A BLE HID library, chosen in the Phase 4 spike. NimBLE-based is likely, since it is lighter than Bluedroid.
- Flashing: `tools\flash.cmd`, which wraps arduino-cli, mklittlefs and esptool ([FLASHING.md](FLASHING.md)). The Arduino IDE and its LittleFS upload plugin aren't used for v2, because the IDE doesn't have the pinned core installed.

### Pinned versions (`sketch.yaml`)

[`code/WebTurntable/sketch.yaml`](../code/WebTurntable/sketch.yaml) holds an arduino-cli build profile, `esp32`, that pins the board options, core and libraries:

| Component | Version |
|---|---|
| esp32:esp32 core | 3.3.12 |
| ESP Async WebServer | 3.12.1 |
| Async TCP | 3.5.0 |
| ArduinoJson | 7.4.3 |

Compile check:

```sh
arduino-cli compile --profile esp32 code/WebTurntable
```

- On the first run, arduino-cli downloads the profile's core and libraries into `Arduino15/internal/`, separate from what the IDE has installed. That takes a few minutes and about 6.5 GB, since core 3.x ships prebuilt libraries for every ESP32 chip.
- The arduino-cli 0.34.0 bundled with Arduino IDE 2.2.1 handles the profile (checked 2026-10-14), so a standalone arduino-cli is optional. See [CLAUDE.md](../CLAUDE.md#build-and-flash) for where the bundled copy lives.
- Arduino IDE 2 ignores profiles, so v2 is built and flashed with arduino-cli only ([FLASHING.md](FLASHING.md)). Building from the IDE would mean installing the same versions there as well, another ~6.5 GB.
- To bump a version, edit `sketch.yaml`, compile-check, and update the table above in the same commit.

**Size baseline.** A test sketch using Wi-Fi AP, AsyncWebServer with a WebSocket, ArduinoJson, LittleFS, Preferences and a GPTimer compiles to 994 KB of flash (50% of the 1.875 MB app slot) and 46.6 KB of static RAM (14%). The BLE stack in Phase 4 comes on top of that. On the default partition scheme, this baseline alone would already use 76% of the app slot. The Phase 1 firmware is 1,008 KB (51%) with 46.6 KB of static RAM, and compiles without warnings under `--warnings all`.

## Modules

| File | Responsibility |
|---|---|
| `WebTurntable.ino` | `setup()`/`loop()`: initialize modules, run the sequencer and storage ticks |
| `config.h` | Pins, motor constants, limits |
| `motion.{h,cpp}` | Step generation, position, acceleration; run/move/stop API |
| `sequencer.{h,cpp}` | Jobs: spin with a stop condition, sweep, photo capture, video capture |
| `shutter.{h,cpp}` | BLE HID shutter: advertising, connection state, `press()` |
| `storage.{h,cpp}` | Last-used state (debounced) and presets |
| `server.{h,cpp}` | Wi-Fi AP, HTTP, WebSocket protocol, state broadcast |
| `data/` | Web UI |

## Motion engine

**Units.** Position is a signed 32-bit count of half-steps. The 28BYJ-48 gear ratio is about 63.684:1, so one revolution is 2037.886 full steps, or 4075.77 half-steps. The commonly quoted 2048 would be 0.5% off, about 1.8° per revolution. The disk sits directly on the shaft, so one half-step is about 0.088° of disk rotation. Phase 2 confirms the ratio on the real motor.

**Phase table.** One 8-entry half-step table, as in v1:

- Half-step mode moves 1 entry per step.
- Two-phase full-step mode moves 2 entries at a time and stays on the odd entries, where two coils are on. That gives more torque than v1's one-coil "full" pattern.
- Both modes count position in half-steps, so switching modes never loses position.

**Timing.** Step generation is split between a timer interrupt and a control task:

- **Timer interrupt (ISR).** A hardware timer (GPTimer) fires once per step. Its callback writes the coil pattern, updates the position, and sets the next alarm from a shared `stepIntervalUs`.
  - Keep the ISR short, in IRAM, and integer-only (avoid floating point in ISRs on the ESP32).
  - For moves, it stops exactly at the target position.
- **Control task.** A FreeRTOS task at about 1 kHz does the floating-point work. It ramps `stepIntervalUs` toward the target speed at constant acceleration, and starts decelerating when the remaining steps drop to v²/(2a).

**API (sketch).**

```cpp
void motionBegin();
void motionRun(float rpm, Direction dir);   // continuous; ramps to speed
void motionMoveBy(int32_t halfSteps);       // relative move with ramps
void motionMoveTo(int32_t halfSteps);       // absolute, from the session zero
void motionStop();                          // ramp down
void motionHalt();                          // immediate stop, coils off
void motionSetZero();
MotionStatus motionStatus();                // position, speed, state
```

**Idle.** The coils switch off when the motor stops, as in v1, so the motor stays cool. If the disk drifts during capture settle times, add an optional hold.

**Limits.** v1 runs at about 1.5–16.4 RPM. v2 aims for about 0.5 RPM up to the fastest speed that doesn't skip steps with a typical load and ramps; that limit has to be measured on hardware. Max speed and acceleration are user settings.

## Sequencer jobs

| Job | Parameters | Ends when |
|---|---|---|
| Spin | RPM, direction, optional stop after N revolutions or T minutes | Stop condition met, or STOP |
| Sweep | Range° (or angles A and B), RPM, dwell (ms), cycles or T minutes | Cycles or time done, or STOP |
| Photo capture | Shots (or step°), direction, settle (ms), after-shot wait (ms), shutter on/off, return to start | All shots taken |
| Video capture | Motion (one revolution at a set RPM, a sweep, or a timed spin), lead-in (ms), lead-out (ms) | Motion done |

The photo capture loop is: move one step angle, wait the settle time, press the shutter, wait the after-shot time, repeat. Capture jobs can be paused and resumed. STOP from the UI always halts motion and cancels the running job.

## Shutter (BLE HID)

- **Pairing:** the device advertises as a BLE keyboard named "Turntable Shutter". It bonds once and reconnects automatically after that.
- **Shutter press:** `press()` sends Volume Up. In stock iOS and Android camera apps, that takes a photo, or starts or stops recording in video mode. The key is configurable in case an app maps volume to zoom.
- **No confirmation:** the link is one-way, so the firmware can't tell whether a photo was actually taken. The UI shows connected/disconnected and has a Test button.
- **Radio sharing:** Bluetooth and the Wi-Fi AP share one radio, which is fine for this little traffic. Check range with the enclosure closed.

## WebSocket protocol v2 (draft)

One endpoint, `/ws`, carrying JSON text frames. Each client-to-device command has a `cmd` field. The device broadcasts the full `state` to every client whenever something changes, and about 10 times a second while the disk is moving.

Commands (client to device):

```json
{"cmd":"run","rpm":5.0,"dir":"cw"}
{"cmd":"stop"}
{"cmd":"halt"}
{"cmd":"moveBy","deg":-90}
{"cmd":"moveTo","deg":180,"dir":"shortest"}
{"cmd":"setZero"}
{"cmd":"sweep","rangeDeg":90,"rpm":3,"dwellMs":500,"cycles":4}
{"cmd":"capture","type":"photo","shots":36,"settleMs":800,"afterMs":500,"dir":"cw"}
{"cmd":"capturePause"}
{"cmd":"captureResume"}
{"cmd":"captureCancel"}
{"cmd":"shutterTest"}
{"cmd":"presetSave","name":"Product 36"}
{"cmd":"presetApply","id":3}
{"cmd":"presetDelete","id":3}
{"cmd":"settings","driveMode":"half","maxRpm":15,"accel":20}
```

Messages (device to client):

```json
{"type":"state","job":"capture","running":true,"angle":120.3,"rpm":5.0,"dir":"cw",
 "progress":{"done":12,"total":36,"etaS":48},"shutter":"connected",
 "settings":{"driveMode":"half","maxRpm":15,"accel":20}}
{"type":"presets","items":[{"id":1,"name":"Slow spin"}]}
{"type":"error","msg":"shutter not connected"}
```

Directions are strings rather than enum numbers, which removes the v1 CW/OFF/CCW mismatch.

## Persistence

- **Last-used state:** stored in NVS (`Preferences`), written after 750 ms of idle as in v1. NVS is wear-levelled and suits small key-value data.
  - Done in Phase 1: namespace `turntable`, key `settings`, holding the `TurntableSettings` struct as a blob. A load is rejected if the size or magic number doesn't match. Bump `MAGIC` when the struct layout changes, so old data is ignored rather than misread.
  - NVS sits outside the LittleFS partition, so firmware and web UI uploads both keep it.
- **Presets:** stored in `/presets.json` on LittleFS, about 10 entries.
  - Uploading the web UI rewrites the whole LittleFS partition, so it would also erase the presets.
  - Decide in Phase 3: keep presets in NVS instead (it survives both firmware and web UI uploads), or accept the loss and document it.
- **Angle and zero:** not persisted (see [Angle control without homing](ROADMAP.md#angle-control-without-homing)).

## Web UI

- Vanilla HTML/CSS/JS with no build step and no CDN; the phone has no internet while it is on the turntable's AP.
- **Header:** live angle dial, connection status, shutter status.
- **Controls:** an always-visible STOP and tabs for Spin, Sweep and Capture.
- **Position tools:** Set zero, ±15/45/90° buttons, Go to angle.
- **Presets** list, plus advanced settings: drive mode, acceleration, max speed, shutter key.
- Speed controls show both RPM and seconds per revolution.
- The page reconnects automatically (as in v1) and reflects changes made from other clients.

## Testing

- Compile-check with arduino-cli before every flash (see [Pinned versions](#pinned-versions-sketchyaml)).
- UI: develop against the Node mock server ([tools/mock-server](../tools/mock-server/README.md)) and check it at phone width. Run `node tools/mock-server/server.js`, then open `http://127.0.0.1:8080/`. It emulates the v1 protocol today; Phase 2 adds v2.
- The UI connects to `ws://${location.host}/ws`. Using `host` rather than `hostname` keeps the port, so the page works on the mock's port as well as on the device's port 80.
- Hardware (done by the user): use each phase's "Done when" checks in the roadmap. Serial logs at 115200 baud.
