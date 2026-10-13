# Firmware v2 design (ESP32)

This describes the target firmware, not the current code. The v1 code is summarized in [CLAUDE.md](../CLAUDE.md). Update this doc when implementation changes the design.

## Toolchain

- Arduino IDE 2.x or arduino-cli, with the ESP32 Arduino core 3.x.
- Board: "ESP32 Dev Module" (or "DOIT ESP32 DEVKIT V1").
- Partition scheme: **Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)**.
  - Wi-Fi, Bluetooth and the web server together are likely too big for the default 1.2 MB app slot.
  - This scheme also gives the two app slots that OTA needs (Phase 5).
  - 190 KB is plenty for the web UI (about 21 KB) and presets. LittleFS uses this "spiffs" partition by default.
- Libraries:
  - ESPAsyncWebServer and AsyncTCP (both from ESP32Async).
  - ArduinoJson 7, replacing Arduino_JSON because presets need nested objects.
  - A BLE HID library, chosen in the Phase 4 spike. NimBLE-based is likely, since it is lighter than Bluedroid.
- Web UI upload: the arduino-littlefs-upload plugin (supports ESP32).
- Pin the core and library versions in `sketch.yaml` so builds are reproducible.

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
- **Presets:** stored in `/presets.json` on LittleFS, about 10 entries.
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

- Compile-check with arduino-cli before every flash (Phase 0).
- UI: develop against the Node mock server and check it at phone width.
- Hardware (done by the user): use each phase's "Done when" checks in the roadmap. Serial logs at 115200 baud.
