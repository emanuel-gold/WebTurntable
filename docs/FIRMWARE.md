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
  - NimBLE-Arduino (h2zero) for the Bluetooth shutter, chosen in the Phase 4 spike because it's lighter than the core's Bluedroid-based BLE library.
- Flashing: `tools\flash.cmd`, which wraps arduino-cli, mklittlefs and esptool ([FLASHING.md](FLASHING.md)). The Arduino IDE and its LittleFS upload plugin aren't used for v2, because the IDE doesn't have the pinned core installed.

### Pinned versions (`sketch.yaml`)

[`code/WebTurntable/sketch.yaml`](../code/WebTurntable/sketch.yaml) holds an arduino-cli build profile, `esp32`, that pins the board options, core and libraries:

| Component | Version |
|---|---|
| esp32:esp32 core | 3.3.12 |
| ESP Async WebServer | 3.12.1 |
| Async TCP | 3.5.0 |
| ArduinoJson | 7.4.3 |
| NimBLE-Arduino | 2.5.1 (Phase 4, Bluetooth shutter) |

Compile check:

```sh
arduino-cli compile --profile esp32 code/WebTurntable
```

- On the first run, arduino-cli downloads the profile's core and libraries into `Arduino15/internal/`, separate from what the IDE has installed. That takes a few minutes and about 6.5 GB, since core 3.x ships prebuilt libraries for every ESP32 chip.
- The arduino-cli 0.34.0 bundled with Arduino IDE 2.2.1 handles the profile (checked 2026-10-14), so a standalone arduino-cli is optional. See [CLAUDE.md](../CLAUDE.md#build-and-flash) for where the bundled copy lives.
- Arduino IDE 2 ignores profiles, so v2 is built and flashed with arduino-cli only ([FLASHING.md](FLASHING.md)). Building from the IDE would mean installing the same versions there as well, another ~6.5 GB.
- To bump a version, edit `sketch.yaml`, compile-check, and update the table above in the same commit.

**Size baseline.** A test sketch using Wi-Fi AP, AsyncWebServer with a WebSocket, ArduinoJson, LittleFS, Preferences and a GPTimer compiles to 994 KB of flash (50% of the 1.875 MB app slot) and 46.6 KB of static RAM (14%). The BLE stack in Phase 4 comes on top of that. On the default partition scheme, this baseline alone would already use 76% of the app slot. The Phase 2 firmware (motion engine, protocol v2, mDNS) is 1,052 KB (53%) with 48.9 KB of static RAM. Phase 3 (sequencer, presets) brings it to 1,093 KB (55%) with 50.4 KB. Phase 4 adds the NimBLE stack and captures: 1,356 KB (68%) with 60.7 KB of static RAM, of which NimBLE is about 253 KB and 10 KB. It compiles without warnings under `--warnings all`. The boot log prints the free heap after Wi-Fi and Bluetooth start.

## Modules

| File | Responsibility |
|---|---|
| `WebTurntable.ino` | `setup()`/`loop()`: initialize modules, run the sequencer and storage ticks |
| `config.h` | Pins, motor constants, limits |
| `motion.{h,cpp}` | Step generation, position, acceleration; run/move/stop API |
| `sequencer.{h,cpp}` | Everything that starts motion from `loop()`: moves, spin with a stop condition, sweep, and the photo and video captures on top of them |
| `presets.{h,cpp}` | Presets, in NVS |
| `shutter.{h,cpp}` | BLE HID shutter (NimBLE): advertising, pairing, connection state, key presses |
| `server.{h,cpp}` | HTTP, WebSocket protocol, state broadcast, settings persistence (last-used state, debounced) |
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
int32_t motionSetZero();                            // returns how far zero moved
void motionSetDriveMode(DriveMode mode);
void motionSetAcceleration(float rpmPerSecond);
MotionStatus motionStatus();                        // state, position, angle, speed
```

Requests are queued under a spinlock and picked up on the next control tick (at most 1 ms later).

**Moves in degrees.** `sequencer.cpp` turns degrees into half-step targets. It keeps the last target in degrees and builds the next Rotate by on it while the move is unfinished, or while the disk still sits on that target. That way 24 presses of +15° land back on the starting angle, instead of piling up 0.18 half-steps of rounding per press. Go to angle measures from the current position (shortest way, CW or CCW).

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
| Sweep | Angles From and To, RPM, dwell (ms), N cycles or T minutes | Cycles or time done, or STOP |
| Photo capture | Shots and step°, direction, settle (ms), after-shot wait (ms), shutter on/off, return to start, start delay | All shots taken (and back at the start) |
| Video capture | Motion (the Spin or Sweep options, so a set number of turns, a timed spin, or a sweep), direction for a spin, lead-in (ms), lead-out (ms), start delay | Lead-out done |

The photo capture loop is: wait the settle time, press the shutter, wait the after-shot time, move one step, repeat. Photo captures can be paused and resumed. STOP from the UI always halts motion and cancels the running job.

**Implemented in Phase 3** (`sequencer.cpp`). `handleSequencer()` runs in `loop()` right after the commands, and drives the motion engine through its public API only. A new job, a move or STOP replaces whatever was running. Plain moves (Rotate by, Go to) go through the sequencer as well, though they don't count as jobs in the state.

- **Spin with a revolution count:** a move to the starting position plus N turns, so it ramps into the last turn and lands back on its starting angle. Fractions are fine: 1.5 turns lands opposite.
- **Spin with a time limit:** a plain spin that ramps down once the time is up.
- **Sweep:**
  - It goes the short way to the copy of From nearest the disk, and the other end is To − From beyond that. The ends are fixed half-step targets, so cycles don't drift.
  - Then it travels to To and back, dwelling at each end with the coils off. Coming back to From completes a cycle, so a counted sweep ends on From.
  - Once the time limit is up, the sweep stops at the next end it reaches: at once if it's dwelling, otherwise at the end of the current leg.
- **Speed changes** apply live: a spin is re-requested at the new speed, and a move, counted spin or sweep leg re-requests the same target at the new speed. During a dwell, the next leg picks up the new speed.
- **Set zero during a job:** `motionSetZero()` returns how far zero moved, and the sequencer shifts its targets by that much, so a running job keeps going to the same physical places.
- **Limits** (`config.h`):
  - Revolution counts 0.1–1000, times 0.1–600 minutes, cycles 1–1000.
  - Sweep angles ±3600°, dwell 0–60 s.
  - From and To have to land on different half-steps.

**Captures (Phase 4).** A capture runs on top of the motion jobs. It starts moves, spins and sweeps with the same internal functions as the commands do, and waits until they finish. Anything else that starts motion, and STOP, ends the capture first.

- **Starting:** a capture ramps down whatever was running, then waits out its start delay (default 5 s, time to open the camera app) and for the disk to be still.
- **Photo:**
  - The first shot is where the disk stands. Each later target counts from that start (start + n × step), so steps don't add up rounding errors.
  - Each shot: settle, press, wait, then move one step. After the last shot it goes back to the start the short way, which after a full turn is one more step forward.
  - Pause takes effect before the next press or move. Resume restarts that stage's wait, so the disk settles again (or the start delay runs again).
  - If no phone is ready when a press is due, the capture pauses itself (`needsShutter`) instead of missing a shot. Resume retries it.
  - With "press the shutter" off, it's a dry run that needs no phone.
- **Video:** press (start recording), lead-in, then the Spin or Sweep options' motion (a spin uses the video's own direction), then lead-out, then press (stop recording).
  - A spin or sweep with no limit records until STOP.
  - Ending a video that's recording, by STOP or by starting anything else, sends one more press, so the camera doesn't keep recording (the user's choice, 2026-10-21).
  - It needs a phone at the start. If the phone has gone by the first press, it pauses like a photo capture.
- **Limits** (`config.h`): up to 720 shots, steps 0.1–360°, every wait 0–60 s.

## Shutter (BLE HID, Phase 4, `shutter.cpp`)

- **Library:** NimBLE-Arduino 2.5.1 (picked in the Phase 4 spike). It brings its own BLE host on top of the controller in the core, and builds against core 3.3.12 without warnings. The alternative was the core's own BLE library (the Bluedroid host, with `BLEHIDDevice`). It wasn't tried, because Bluedroid is the larger stack and NimBLE fit easily.
- **Pairing:** the device advertises as "Turntable Shutter" (appearance: generic HID, HID service 0x1812), with Just Works pairing and bonding. The phone pairs once and reconnects by itself after that. NimBLE keeps the bonds in its own NVS namespace, so uploads keep them. **Forget paired phones** deletes them; the phone also needs Forget This Device.
- **Report map:** consumer control only, Volume Up and Volume Down, one bit each. There's deliberately no keyboard page, because iOS hides its on-screen keyboard while a Bluetooth keyboard is connected, and the same iPhone types in the web UI.
- **Press:** key down, then key up 60 ms later (`handleShutter()` in `loop()`). Short, so the Camera app takes a photo rather than starting QuickTake video, which a held volume button does. In video mode, a press starts or stops recording. The key is Volume Up by default, or Volume Down, in case an app maps one of them to something else.
- **Ready** means connected, encrypted and subscribed to the input report. Only then are presses sent; the state shows `connected` and `ready` separately, so "Pairing…" can show in between.
- **On/off:** off stops advertising and drops the phone, so the radio stays quiet. The stack stays initialised, so turning it back on is instant.
- **No confirmation:** the link is one-way, so the firmware can't tell whether a photo was actually taken. The UI shows the connection and has a Test button.
- **Radio sharing:** Bluetooth and Wi-Fi share one radio with the core's software coexistence. Wi-Fi modem sleep must stay on (the default) while Bluetooth runs, or the ESP32 aborts. Check range with the enclosure closed.

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
- Moves run at the speed setting, and a move ends a spin. A speed change applies to whatever is running, moves included (Phase 3).

**Added in Phase 3:**

```json
{"cmd":"spinOptions","stopAfter":"revs","stopValue":3}           // any subset; stopAfter: never, revs or minutes
{"cmd":"sweepOptions","fromDeg":-30,"toDeg":30,"dwellMs":500,"stopAfter":"cycles","stopValue":4}
                                                                  // any subset; stopAfter: never, cycles or minutes
{"cmd":"sweep"}                                                   // start a sweep; takes rpm and any sweepOptions fields
{"cmd":"presetSave","name":"Front sweep","mode":"sweep"}          // speed + that mode's options; a taken name is replaced
{"cmd":"presetApply","id":3}                                      // loads them; doesn't start anything
{"cmd":"presetDelete","id":3}
```

- `run` also takes the `spinOptions` fields.
- The options are settings: they're kept, saved, and broadcast in the state, and a start command uses them. The UI sends each field as it changes, and sends them all again with Start and Save.
- `stopValue` keeps its number when `stopAfter` is `never`, so switching a limit back on brings the last value back.
- Preset names are 1–63 bytes of UTF-8. The UI allows 24 characters.
- Errors found when a command runs (From equal to To, all 10 presets used, a preset that's gone) go to the client that sent it, after the state broadcast.

**Added in Phase 4:**

```json
{"cmd":"photoOptions","shots":36,"stepDeg":10,"settleMs":800,"afterMs":500,"dir":"cw",
 "returnToStart":true,"pressShutter":true,"delayMs":5000}         // any subset
{"cmd":"videoOptions","motion":"spin","dir":"cw","leadInMs":1000,"leadOutMs":1000,"delayMs":5000}   // any subset
{"cmd":"photo"}                                                   // start; takes rpm and any photoOptions fields
{"cmd":"video"}                                                   // start; takes rpm and any videoOptions fields
{"cmd":"capturePause"}                                            // photo only, before the next press or move
{"cmd":"captureResume"}                                           // photo, or a capture waiting for the phone
{"cmd":"shutter","enabled":true,"key":"volumeUp"}                 // any subset; key: volumeUp or volumeDown
{"cmd":"shutterTest"}                                             // one press
{"cmd":"shutterForget"}                                           // drop the phone and forget all pairings
```

- Like the Phase 3 options, the photo and video options are settings, saved and broadcast. A video's motion uses the current `spin` or `sweep` options.
- Cancelling is STOP. There is no `captureCancel`.
- `presetSave` and presets take `photo` and `video` modes too. A video preset also keeps its spin or sweep, nested in the presets message.
- Start errors: no phone ready (a photo that presses, or any video), or a video sweep whose ends are the same.

```json
{"type":"state","motion":"moving","angle":120.3,"speed":-4.87,"rpm":5.00,"dir":"cw","spinning":false,
 "job":{"type":"photo","stage":"move","paused":false,"shot":13,"shots":36},
 "spin":{"stopAfter":"never","stopValue":1.00},
 "sweep":{"fromDeg":-30.0,"toDeg":30.0,"dwellMs":500,"stopAfter":"cycles","stopValue":4.00},
 "photo":{"shots":36,"stepDeg":10.00,"settleMs":800,"afterMs":500,"dir":"cw","returnToStart":true,
          "pressShutter":true,"delayMs":5000},
 "video":{"motion":"spin","dir":"cw","leadInMs":1000,"leadOutMs":1000,"delayMs":5000},
 "shutter":{"enabled":true,"key":"volumeUp","connected":true,"ready":true},
 "settings":{"driveMode":"half","maxRpm":20.0,"accel":20.0},
 "wifi":{"mode":"lan","ssid":"Home","ip":"192.168.1.42","rssi":-58},
 "limits":{"minRpm":0.5,"maxRpm":20,"minAccel":1,"maxAccel":200,"minRevs":0.1,"maxRevs":1000,
           "minMinutes":0.1,"maxMinutes":600,"maxCycles":1000,"maxSweepDeg":3600,"maxDwellMs":60000,
           "maxShots":720,"minStepDeg":0.1,"maxStepDeg":360,"maxWaitMs":60000}}
{"type":"presets","presets":[
  {"id":0,"name":"Two slow turns","mode":"spin","rpm":3.00,"stopAfter":"revs","stopValue":2.00},
  {"id":1,"name":"Front sweep","mode":"sweep","rpm":8.00,"fromDeg":-30.0,"toDeg":30.0,"dwellMs":500,"stopAfter":"cycles","stopValue":4.00},
  {"id":2,"name":"Product 36","mode":"photo","rpm":5.00,"shots":36,"stepDeg":10.00,"settleMs":800,"afterMs":500,
   "dir":"cw","returnToStart":true,"pressShutter":true,"delayMs":5000},
  {"id":3,"name":"Turn video","mode":"video","rpm":5.00,"motion":"spin","dir":"cw","leadInMs":1000,"leadOutMs":1000,
   "delayMs":5000,"spin":{"stopAfter":"revs","stopValue":1.00}}]}
{"type":"error","msg":"run needs dir cw or ccw"}
```

- `motion` is `idle`, `running`, `moving` or `stopping`.
- `speed` is the current speed, signed (positive clockwise).
- `rpm` and `dir` are the spin settings, and `spinning` says whether a spin job is on.
- `job` is `null`, or the running job:
  - A spin with a count adds `revsLeft`.
  - A sweep adds `cycle` (from 1), plus `cycles` with a count.
  - Either adds `secondsLeft` with a time limit. At 0, a sweep is finishing its last leg.
  - A photo or video adds `stage` (`delay`, then `move`, `settle`, `shot` and `return` for a photo, or `leadIn`, `motion` and `leadOut` for a video), `paused`, and `needsShutter` when it paused for want of a phone. In `delay`, `startsIn` is the countdown in seconds.
  - A photo adds `shot` (from 1) and `shots`. A video adds `motion` (`spin` or `sweep`); during the motion, it also carries that spin's or sweep's fields above.
- `shutter.connected` means a phone is connected; `ready` means it's paired and listening, so presses go through.
- The state is broadcast 10 times a second while the disk moves or a job runs, so it continues through dwells and waits. It's also broadcast when the shutter connects or disconnects.
- A new client gets the state, then the presets. The presets go to everyone after each save or delete.
- Errors go only to the client that sent the bad command.

Directions are strings rather than enum numbers, which removes the v1 CW/OFF/CCW mismatch.

## Persistence

- **Last-used state:** stored in NVS (`Preferences`), written after 750 ms of idle as in v1. NVS is wear-levelled and suits small key-value data.
  - Namespace `turntable`, key `settings`, holding the `TurntableSettings` struct as a blob: rpm, dir, drive mode, max speed, acceleration, and the spin and sweep options (`MAGIC` "TTB3", Phase 3; Phase 2's "TTB2" also held `spinning`).
  - A load is rejected if the size or magic number doesn't match. Bump `MAGIC` when the struct layout changes, so old data is ignored rather than misread. Loaded values are clamped to the limits.
  - Flash writes pause the step timer for a moment, so saves wait while the disk moves to a target, where every step counts. That includes counted spins and sweep legs; a sweep's dwell counts as idle. A spin is saved as it runs (decided 2026-10-21): a brief hitch there only nudges the dial, and it means a speed change mid-spin survives a power cut.
  - The photo, video and shutter settings (Phase 4) are a second blob, key `capture` (`CaptureSettings`, `MAGIC` "CAP1"), saved together with `settings`. A separate key let `TTB3` keep its layout, so Phase 3 settings survived the Phase 4 update. A missing or mismatched `capture` blob just means defaults for those.
  - Running jobs aren't saved, so the disk always starts stopped after a power cut (decided 2026-10-21; v1 resumed the spin).
  - NVS sits outside the LittleFS partition, so firmware and web UI uploads both keep it.
- **Presets** (Phase 3, `presets.cpp`): in NVS too, so both uploads keep them (decided 2026-10-21, instead of `/presets.json` on LittleFS, which a web UI upload would erase).
  - Namespace `presets`, keys `p0` to `p9`, one `Preset` struct per slot with its own magic number. A slot that fails to load is skipped. Loaded values are clamped like settings.
  - Phase 4's layout ("PRS2") adds the photo and video options. Phase 3 presets ("PRS1", told apart by their size) are converted when they load, with default photo and video options, and rewritten in the new layout when next saved. Bump the magic and add a conversion like this whenever the layout changes, so presets survive.
  - Kept in RAM, and written (or removed) under the same rule as settings, but without the debounce. Changing Wi-Fi saves them first, since it restarts.
- **Bluetooth pairings:** NimBLE's own NVS namespace. Firmware and web UI uploads keep them; **Forget paired phones** clears them.
- **Angle and zero:** not persisted (see [Angle control without homing](ROADMAP.md#angle-control-without-homing)).

## Web UI

- Vanilla HTML/CSS/JS with no build step and no CDN; the phone has no internet while it is on the turntable's AP.
- **Header:** live angle dial, connection status, and a shutter pill (hidden while the shutter is off). Under the angle, what's left of the running job.
- **Controls:** an always-visible STOP, and a Motion card with tabs for Spin, Sweep, Photo and Video under one speed slider. A job started from any phone brings its tab forward. The open tab is remembered per browser.
  - Photo and Video show the shutter's state with a Test button, an estimate of the time, and a Start button that becomes Pause/Resume (photo) or Stop video while it runs.
  - Typing the number of shots fills in the step for one full turn; changing the step afterwards covers part of a turn (the user's choice, 2026-10-21).
- **Position tools:** Set zero, ±15/45/90° buttons, Go to angle.
- **Presets** card: tap to load (switching to its tab; nothing moves until Start), two taps to delete, and Save for the open tab.
- **Settings:** drive mode, acceleration, max speed, the Bluetooth shutter (on/off, key, Test, Forget paired phones), and Wi-Fi.
- Speed controls show both RPM and seconds per revolution.
- The page reconnects automatically (as in v1) and reflects changes made from other clients.

## Testing

- Compile-check with arduino-cli before every flash (see [Pinned versions](#pinned-versions-sketchyaml)).
- UI: develop against the Node mock server ([tools/mock-server](../tools/mock-server/README.md)) and check it at phone width. Run `node tools/mock-server/server.js`, then open `http://127.0.0.1:8080/`. It emulates protocol v2, with the same ramp and move logic as the firmware, so the dial and speeds behave realistically.
- The UI connects to `ws://${location.host}/ws`. Using `host` rather than `hostname` keeps the port, so the page works on the mock's port as well as on the device's port 80.
- Hardware (done by the user): use each phase's "Done when" checks in the roadmap. Serial logs at 115200 baud.
