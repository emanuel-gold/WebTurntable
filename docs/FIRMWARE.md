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

**Size baseline.** A test sketch using Wi-Fi AP, AsyncWebServer with a WebSocket, ArduinoJson, LittleFS, Preferences and a GPTimer compiles to 994 KB of flash (50% of the 1.875 MB app slot) and 46.6 KB of static RAM (14%). The BLE stack in Phase 4 comes on top of that. On the default partition scheme, this baseline alone would already use 76% of the app slot. The Phase 2 firmware (motion engine, protocol v2, mDNS) is 1,052 KB (53%) with 48.9 KB of static RAM, and compiles without warnings under `--warnings all`.

## Modules

| File | Responsibility |
|---|---|
| `WebTurntable.ino` | `setup()`/`loop()`: initialize modules, run the sequencer and storage ticks |
| `config.h` | Pins, motor constants, limits |
| `motion.{h,cpp}` | Step generation, position, acceleration; run/move/stop API |
| `sequencer.{h,cpp}` | Jobs: spin with a stop condition, sweep, photo capture, video capture |
| `shutter.{h,cpp}` | BLE HID shutter: advertising, connection state, `press()` |
| `storage.{h,cpp}` | Last-used state (debounced) and presets |
| `server.{h,cpp}` | HTTP, WebSocket protocol, state broadcast, settings persistence |
| `wireless.{h,cpp}` | Wi-Fi: joining the saved network, the setup access point and captive page, mDNS, reset button |
| `data/` | Web UI |

## Motion engine

**Units.** Position is a signed 32-bit count of half-steps (`HALF_STEPS_PER_REV` in `config.h`). 28BYJ-48s come in two gear ratios: about 63.684:1 (2037.886 full steps per revolution) and exactly 64:1 (2048). This one measured as the 64:1 variant (2026-10-21), so one revolution is 4096 half-steps. With the datasheet value, ten revolutions stopped about 18.5 mm short at the 50 mm rim, about 2.1° per revolution, which works out to roughly 4100 half-steps. The disk sits directly on the shaft, so one half-step is about 0.088° of disk rotation.

**Phase table.** One 8-entry half-step table, as in v1:

- Half-step mode moves 1 entry per step.
- Two-phase full-step mode moves 2 entries at a time and stays on the odd entries, where two coils are on. That gives more torque than v1's one-coil "full" pattern.
- Both modes count position in half-steps, so switching modes never loses position.

**Direction and angle.** Positive is clockwise looking down at the disk, so angles grow clockwise from the session zero, like a compass. Clockwise walks the phase table backwards, as in v1.

**Timing** (implemented in Phase 2, `motion.cpp`). Step generation is split between a timer interrupt and a control task, both on core 1, away from Wi-Fi on core 0:

- **Timer interrupt (ISR).** A GPTimer at 1 MHz fires once per step event. The callback writes the coil pattern straight to the GPIO set and clear registers, updates the position, and schedules the next alarm `stepIntervalUs` after the previous one (never in the past).
  - It's integer-only and lives in IRAM.
  - For moves it never steps past the target, and stops exactly on it.
  - In full-step mode it takes one half-step first if needed to land on a two-coil phase.
- **Control task.** A FreeRTOS task at 1 kHz (priority 5) does the floating-point work.
  - It ramps the velocity at constant acceleration: toward the cruise speed for a spin, through zero for a direction change, and down to zero for a stop.
  - For moves, it starts braking when the remaining distance drops to v²/(2a) + 1 half-step.
  - It hands the ISR a direction and an interval. Below `START_RPM` (1 RPM) the motor steps without a ramp, so a ramp starts and ends there.
- **Flash writes pause stepping.** The core's prebuilt libraries don't set `CONFIG_GPTIMER_ISR_IRAM_SAFE`, so the step interrupt waits while flash is written. Settings saves therefore wait until the motor is idle.

**API** (`motion.h`):

```cpp
void motionBegin();
void motionRun(float rpm, Direction dir);           // continuous; ramps to speed and direction
void motionMoveTo(int32_t position, float rpm);     // half-steps from the session zero
void motionStop();                                  // ramp down
void motionHalt();                                  // immediate stop, coils off
void motionSetZero();
void motionSetDriveMode(DriveMode mode);
void motionSetAcceleration(float rpmPerSecond);
MotionStatus motionStatus();                        // state, position, angle, speed
```

Requests are queued under a spinlock and picked up on the next control tick (at most 1 ms later).

**Moves in degrees.** `server.cpp` turns degrees into half-step targets. It keeps the last target in degrees and builds the next Rotate by on it while the move is unfinished, or while the disk still sits on that target. That way 24 presses of +15° land back on the starting angle, instead of piling up 0.18 half-steps of rounding per press. Go to angle measures from the current position (shortest way, CW or CCW).

**Idle.** The coils switch off when the motor stops, as in v1, so the motor stays cool. If the disk drifts during capture settle times, add an optional hold.

**Limits** (`config.h`). Speed runs from 0.5 RPM up to the max speed setting (default and ceiling both 20). Acceleration is 1–200 RPM/s (default 20). Measured 2026-10-21: 25 RPM is clean in half-step, full-step stalls at 25, and both stall at 30. The ceiling is 20 by choice: faster isn't needed, and it leaves margin.

**Command flow.** The AsyncTCP task only parses and validates JSON, replying with an error if a command is bad. Valid commands go on a FreeRTOS queue, and `loop()` runs them, so settings and motion requests are only touched from one thread.

## Wi-Fi and setup (Phase W, `wireless.cpp`)

The turntable joins the user's Wi-Fi as a client, like a smart home device. Its own access point is only for setup, and as a fallback the user can pick.

**States** (`NetworkMode`, shown as `wifi.mode` in the state):

| Mode | Wi-Fi | What happens |
|---|---|---|
| `connecting` | STA | At power-up with a saved network. Moves to `lan` once connected, or to `setup` after 20 s. |
| `lan` | STA | LAN client, with no access point. A drop just reconnects in the background, and no access point appears. |
| `setup` | AP+STA | Open access point `TURNTABLE` at 192.168.4.5, with captive DNS (every name resolves to the turntable) and the setup page. Scans networks for the page. |
| `joining` | AP+STA | Trying the network picked on the setup page, for up to 20 s. A bad password fails after about 3 s. |
| `joined` | AP+STA | Connected and saved. The access point stays up for 30 s so the page can show the address, then closes, and the mode becomes `lan`. |
| `ap` | AP | "Use Turntable as an access point". Not saved: the next power-up starts over. |

- **Entering setup:** no saved network; the saved network not found within 20 s; the reset button (GPIO 4, low for 1 s at power-up); or the `wifiSetup` command.
  - `wifiSetup` sets a flag in RTC memory and restarts. That flag survives `esp_restart()` but not a power cycle.
- **Retrying the saved network:** when setup started only because the saved network wasn't found, the turntable retries it every 60 s, for 15 s at a time. It only does this while no phone is on the setup network, because retries change channel. If the saved network comes back, the access point closes and the mode becomes `lan`.
- **The saved network is replaced only when a new one connects.** A reset, or an abandoned setup, leaves the old one in place. It's stored in NVS namespace `wifi` (keys `ssid` and `pass`, in plain text). `WiFi.persistent(false)` stops the driver from keeping its own copy.
- **Captive portal:** in `setup`, `joining` and `joined`, any request for another host goes to `http://192.168.4.5/setup`, and `/` goes there too. In `ap`, other hosts go to the control UI instead. Phones' connectivity checks (Apple's `hotspot-detect.html`, Android's `generate_204`, Windows' `connecttest.txt`) hit that redirect, so the OS opens the sign-in sheet.
- **mDNS** (`turntable.local`) answers on whichever interface is up.

**Setup page API** (plain HTTP, used by `data/setup.html`):

| Route | Does |
|---|---|
| `GET /setup` | The setup page. |
| `GET /api/wifi/status` | `{"mode","ssid","ip","rssi","error","hostname"}` |
| `GET /api/wifi/scan` | `{"scanning":bool,"networks":[{"ssid","rssi","secure"}]}`. One entry per name, hidden networks left out. Asks for a fresh scan if the last one is over 15 s old. |
| `POST /api/wifi/join` | Form fields `ssid` (1–32 characters) and `password` (empty, or 8–63). Replies 202, or 400 with `{"error"}`. |
| `POST /api/wifi/ap` | Switch to `ap` mode. |

The HTTP handlers run in the AsyncTCP task. They only read a snapshot and post requests under a mutex. `handleNetwork()` in `loop()` owns the state machine.

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

## WebSocket protocol v2

One endpoint, `/ws`, carrying JSON text frames. Each client-to-device command has a `cmd` field. The device broadcasts the full `state` to every client after each command, about 10 times a second while the disk moves, and once when it stops. A new client gets the state as soon as it connects.

**Implemented in Phase 2:**

```json
{"cmd":"speed","rpm":5.0}                       // speed setting; changes a running spin
{"cmd":"run","dir":"cw","rpm":5.0}              // spin; rpm is optional
{"cmd":"stop"}                                  // ramp down
{"cmd":"halt"}                                  // stop now, coils off
{"cmd":"moveBy","deg":-90}                      // relative, positive clockwise
{"cmd":"moveTo","deg":180,"dir":"shortest"}     // dir: shortest (default), cw or ccw
{"cmd":"setZero"}
{"cmd":"settings","driveMode":"half","maxRpm":20,"accel":20}   // any subset
{"cmd":"wifiSetup"}                             // halt, save, restart into Wi-Fi setup
```

- Speeds are clamped to 0.5 RPM–max speed, max speed to 0.5–20, and acceleration to 1–200.
- Lowering the max speed below the speed setting pulls the setting down with it.
- Moves run at the speed setting, and a move ends a spin.

```json
{"type":"state","motion":"moving","angle":120.3,"speed":-4.87,"rpm":5.00,"dir":"cw","spinning":false,
 "settings":{"driveMode":"half","maxRpm":20.0,"accel":20.0},
 "wifi":{"mode":"lan","ssid":"Home","ip":"192.168.1.42","rssi":-58},
 "limits":{"minRpm":0.5,"maxRpm":20,"minAccel":1,"maxAccel":200}}
{"type":"error","msg":"run needs dir cw or ccw"}
```

- `motion` is `idle`, `running`, `moving` or `stopping`.
- `speed` is the current speed, signed (positive clockwise).
- `rpm` and `dir` are the spin settings, and `spinning` says whether a spin is on.
- Errors go only to the client that sent the bad command.

**Planned for later phases** (draft):

```json
{"cmd":"sweep","rangeDeg":90,"rpm":3,"dwellMs":500,"cycles":4}
{"cmd":"capture","type":"photo","shots":36,"settleMs":800,"afterMs":500,"dir":"cw"}
{"cmd":"capturePause"}
{"cmd":"captureResume"}
{"cmd":"captureCancel"}
{"cmd":"shutterTest"}
{"cmd":"presetSave","name":"Product 36"}
{"cmd":"presetApply","id":3}
{"cmd":"presetDelete","id":3}
```

These will add `job`, `progress` and `shutter` fields to the state, and a `{"type":"presets"}` message.

Directions are strings rather than enum numbers, which removes the v1 CW/OFF/CCW mismatch.

## Persistence

- **Last-used state:** stored in NVS (`Preferences`), written after 750 ms of idle as in v1. NVS is wear-levelled and suits small key-value data.
  - Namespace `turntable`, key `settings`, holding the `TurntableSettings` struct as a blob. Phase 2 stores rpm, dir, spinning, drive mode, max speed and acceleration (`MAGIC` "TTB2").
  - A load is rejected if the size or magic number doesn't match. Bump `MAGIC` when the struct layout changes, so old data is ignored rather than misread. Loaded values are clamped to the limits.
  - Flash writes pause the step timer for a moment, so saves wait while the disk moves to a target, where every step counts. A spin is saved as it runs (decided 2026-10-21): a brief hitch there only nudges the dial, and it means a speed change mid-spin survives a power cut.
  - `spinning` is runtime-only: it's cleared at load, so the disk always starts stopped after a power cut (decided 2026-10-21; v1 resumed the spin).
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
- UI: develop against the Node mock server ([tools/mock-server](../tools/mock-server/README.md)) and check it at phone width. Run `node tools/mock-server/server.js`, then open `http://127.0.0.1:8080/`. It emulates protocol v2, with the same ramp and move logic as the firmware, so the dial and speeds behave realistically.
- The UI connects to `ws://${location.host}/ws`. Using `host` rather than `hostname` keeps the port, so the page works on the mock's port as well as on the device's port 80.
- Hardware (done by the user): use each phase's "Done when" checks in the roadmap. Serial logs at 115200 baud.
