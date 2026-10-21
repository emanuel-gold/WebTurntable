# Roadmap: v2 (ESP32)

Goal: move WebTurntable from the ESP8266 (Wemos D1 mini) to an ESP32 DevKit V1. The extra capability goes into smoother motion, angle control and a Bluetooth camera shutter, so the turntable becomes a tool for product photos and turntable video.

Mark items `[x]` as they land.

## Status

_Last updated 2026-10-21._

- **Done:** planning, Phase 0, and Phase 1 (confirmed on hardware 2026-10-15: motor control from the UI, both addresses, settings across a power cycle).
- **Phases 2 and W are flashed and mostly confirmed on hardware (2026-10-21).**
  - **Phase 2 passed:** smooth start, stop and reversal; two devices showing live updates; quick nudges merging.
  - **Phase 2 problem:** positioning stops short. A 360° Rotate by ended about 2.3 mm short at the tape mark, and 3600° about 18.5 mm short. Both runs are short by a similar amount per revolution, and they ran at different speeds, so this looks like the steps-per-revolution constant rather than skipped steps. Assuming the tape sits at the disk's 50 mm radius, that's about 2.1° per revolution, so roughly 4100 half-steps per revolution instead of 4075.77. That's close to the 64:1 (2048 full steps) variant of the 28BYJ-48.
  - **Phase W passed:** setup from the iPhone, joining, reconnect after a power cycle, `turntable.local` on the phone and PC, the wrong-password path, the router-off fallback, Change Wi-Fi network, and access-point mode (controls load in the captive sheet, and a power cycle goes back to the home Wi-Fi).
  - **Problem found and fixed in code (resume-on-power-up):** in access-point mode the user started a CW spin and cut the power. At power-up it spun again straight away, and nothing could stop it until it rejoined the home Wi-Fi. The user decided a power loss must never restart a spin, so the disk now always starts stopped. Needs a firmware flash and a recheck.
  - **Still to test:** the reset button (D4 to GND at power-up) and max speed. See `todo_checks.md`.
- **Next:**
  - Flash the no-resume fix and the CW/CCW toggle (`toolslash.cmd all`), and recheck both.
  - Fix the steps-per-revolution constant (or add a calibration), then rerun the 10-revolution test.
  - Finish the remaining tests.
  - Then Phase 3.
- **Deferred:** the BOOT-button question (open question 2), at the user's call. Phase E needs open question 1.
- **Working style:**
  - Work on main. v1 stays reproducible at tag `v1-esp8266`.
  - Commit per checklist item or logical step.
  - Update this Status section at the end of each session.

## Scope

| Tier | Item | Phase |
|---|---|---|
| MVP | ESP32 port with v1 feature parity | 1 |
| MVP | Timer-driven stepping with acceleration ramps | 2 |
| MVP | Speed in real units (RPM, seconds per revolution) | 2 |
| MVP | Angle control: rotate by, go to, set zero | 2 |
| MVP | Back-and-forth mode, stop timer, presets | 3 |
| MVP | Bluetooth shutter with photo and video capture | 4 |
| MVP | Enclosure v2 for the DevKit | E (parallel) |
| Post-MVP | Firmware updates over Wi-Fi (OTA) | 5 |
| Backlog | Hall sensor homing, touch controls, lighting control, IR shutter | — |
| MVP | Home Wi-Fi with captive-portal setup, access point as fallback | W |

### Angle control without homing

Angle control works without homing. The firmware counts every step, so relative moves ("rotate by 10°") are exact as long as the motor doesn't skip steps. Acceleration ramps and a sensible max speed make skipping unlikely. Absolute angles are measured from a session zero: the position at power-up, or wherever the user presses **Set zero**.

Homing would add a zero that survives power cycles and turning the disk by hand. Until then, a printed index mark on the disk and body (Phase E) gives a repeatable manual zero.

## Phase 0: Prep

- [x] Tag main `v1-esp8266` before any v2 code change, so D1 mini builds stay reproducible.
- [x] Get arduino-cli working (standalone, or the copy bundled with Arduino IDE 2) with ESP32 core 3.x and the v2 libraries ([FIRMWARE.md](FIRMWARE.md#toolchain)). Pin core and library versions in `sketch.yaml` so firmware can be compile-checked before flashing.
- [x] Add a Node mock server (`tools/mock-server/`) that serves `data/` and fakes the WebSocket protocol, so the UI can be built and tested in a browser without hardware.
- [x] Answer the planning questions: board variant, wiring method, USB/power, shutter test phone, the ESP8266 version, and how to flash (see Decisions, 2026-10-14).
- [x] Flash script and instructions for arduino-cli: `tools\flash.cmd`, [FLASHING.md](FLASHING.md).

## Phase 1: ESP32 port (parity)

Same features as v1, running on the DevKit.

- [x] ESP32 includes (`WiFi.h`, `AsyncTCP.h`), the pin map from [HARDWARE.md](HARDWARE.md), and the partition scheme from [FIRMWARE.md](FIRMWARE.md#toolchain).
- [x] Fix the CCW direction mismatch (UI sends `2`, firmware expects `3`). `RotateDirection::CCW` is now 2.
- [x] Status LED on the new pin, with the same error blink as v1.
- [x] Update the README build instructions for ESP32, pointing to [FLASHING.md](FLASHING.md).
- [x] Also done in this phase:
  - Settings moved from a LittleFS file to NVS.
  - ArduinoJson 7 replaces Arduino_JSON.
  - Serial logs at 115200.
  - A race-free save flag (the web server runs on the other core).
  - Periodic WebSocket client cleanup.
  - `code/Basic` ported as a motor-only wiring test.
- [x] Hardware test by the user ([first flash checklist](FLASHING.md#first-flash-checklist)): confirmed 2026-10-15.

**Done when:** the existing UI drives the motor on the DevKit, and settings survive a power cycle.

## Phase 2: Motion engine and core UI

- [x] Hardware-timer step generation that replaces `delayMicroseconds` in `loop()`, with a position counter in half-steps.
- [x] Trapezoidal acceleration and deceleration on start, stop, and speed or direction changes.
- [x] Drive modes: half-step (smooth, default) and two-phase full-step (more torque). Two-phase full-step replaces v1's one-coil "full" pattern.
- [x] Coils off when idle, as in v1.
- [ ] Verify steps per revolution with a 10-revolution test against the index mark (expected 2037.886 full steps). Hardware test: Rotate by 3600°. Done once on 2026-10-21: it stopped about 18.5 mm short at the 50 mm rim, about 2.1° per revolution, or roughly 4100 half-steps per revolution. That matches the 64:1 variant, so `HALF_STEPS_PER_REV` is now 4096. Rerun to confirm.
- [x] Speed set in RPM, with seconds per revolution shown alongside, and a slider linear in RPM.
- [x] Find the real max reliable speed on hardware (v1 tops out around 16 RPM). Measured 2026-10-21: 25 RPM is clean in half-step, full-step stalls at 25, and both stall at 30. The limit is now 25 and the default 20.
- [x] Angle control: live angle dial, Set zero, Rotate by (quick ± buttons and a custom value), Go to angle (shortest path or a chosen direction).
- [x] WebSocket protocol v2 ([FIRMWARE.md](FIRMWARE.md#websocket-protocol-v2)) and UI rework: direction as buttons, plus an always-visible STOP.
- [x] Mock server speaks v2 and simulates the motion engine.
- [ ] Hardware test by the user ([Phase 2 hardware checks](FLASHING.md#phase-2-hardware-checks)).
- [ ] Stretch experiment: PWM microstepping through the ULN2003 (ESP32 LEDC) for quieter low-speed motion. Keep it only if it is clearly better.

**Done when:** start and stop look smooth, a 360° Rotate by returns to the same mark, and two phones show the angle updating live.

## Phase W: Wi-Fi setup (next, before Phase 3)

Joining the user's network like a smart home device, instead of always being an access point. Decided 2026-10-16, after the access point proved too fiddly in daily use (see Decisions). Built in `wireless.cpp`; see [FIRMWARE.md](FIRMWARE.md#wi-fi-and-setup-phase-w-wirelesscpp).

- [x] **No known network:** the turntable starts an open setup access point. Joining it opens a captive page (DNS answers every name with the turntable, and the OS connectivity probes get redirected). The page lists 2.4 GHz networks from a scan, plus "Other network…", and takes the password.
  - [x] On success, the turntable joins as a LAN client and saves the network in NVS. The page shows `turntable.local` and its LAN address with a link to the control UI. The setup access point stays up briefly, then turns off, so the phone falls back to its home Wi-Fi.
  - [x] "Use Turntable as an access point" at the bottom of the list goes to the control UI over the access point. Not persisted: the next power-up shows setup again.
- [x] **Known network:** connects as a LAN client with no visible access point, and is reachable at `turntable.local`. Wi-Fi drops while running just reconnect quietly.
- [x] If the known network isn't found within 20 s of power-up, fall back to setup, keeping the saved network and retrying it every minute while no phone is on the setup network.
- [x] **Reset:** a dedicated push button on GPIO 4 (moved from 22 on 2026-10-21), held at power-up, starts setup. The old network stays saved until a new one connects. (BOOT/GPIO0 can't be used, because holding it at power-up enters flashing mode.) The button needs a hole in the enclosure (Phase E).
- [x] **Change Wi-Fi network** in the control UI's settings (two taps): restarts into setup.
- [x] Mock server and docs (README, FLASHING.md "connecting" steps) updated for the new flow.
- [ ] Hardware test by the user: first setup from the iPhone, a reboot onto home Wi-Fi, `turntable.local` from the phone and PC, the router-off fallback, the reset button, Change Wi-Fi, and access-point mode.
- [ ] Not a blocker: **Wi-Fi status LED** showing setup, connecting, connected, and access-point-only. Either blink patterns on the existing status LED (GPIO 2) or a second LED.

**Done when:** a fresh turntable is set up from the iPhone without typing an address, reboots straight onto the home Wi-Fi, and stays reachable at `turntable.local` from the phone and the PC with both still on the internet.

## Phase 3: Modes, timer, presets

- [ ] Back-and-forth (sweep): range or two end angles, speed, dwell at the ends, cycle count.
- [ ] Stop conditions for spin and sweep: after N revolutions or cycles, or after T minutes. The UI shows what remains.
- [ ] Presets: save the current mode and parameters under a name, then apply or delete it (about 10 slots). Store them somewhere a web UI upload doesn't erase ([FIRMWARE.md](FIRMWARE.md#persistence)).
- [ ] Persist the last-used state for the new modes and parameters, extending Phase 1's debounced NVS store.

**Done when:** a saved preset still reproduces the same motion after a reboot.

## Phase 4: Bluetooth shutter and capture

- [ ] Spike: pick a BLE HID library that works with arduino-esp32 3.x alongside the Wi-Fi AP and AsyncWebServer. Check flash and RAM fit, and test pairing with the iPhone 16 and its default Camera app.
- [ ] Shutter: the device advertises as a BLE keyboard and sends Volume Up (key configurable). The UI shows paired/connected state and has a **Test shutter** button.
- [ ] Photo capture: shots per revolution (or a step angle), settle delay before each shot, wait after each shot, direction, and return to start. The UI shows progress and estimated total time, with pause and cancel.
- [ ] Video capture: shutter press, then the motion (one revolution, a sweep, or a timed spin), then a second press. Lead-in and lead-out delays.

**Done when:** a 36-shot capture runs unattended and leaves 36 photos on the phone, and a one-revolution video starts and stops on its own.

## Phase E: Enclosure v2 (alongside Phases 1–4)

Approach and measurements are in [ENCLOSURE.md](ENCLOSURE.md).

- [x] Measure the DevKit and choose the wiring method; together these set the riser height. Dupont is chosen, and the stack is 22 plus about 8 of wire bend, so the riser is about 31 ([ENCLOSURE.md](ENCLOSURE.md#riser-ring)). The lengthwise hole spacing is still open ([open question 1](#open-questions)); it only affects the cradle.
- [ ] Script and print the **riser ring**, a new part between the body and the bottom plate, with a micro-USB opening.
- [ ] **Bottom plate v2:** the original plate plus a DevKit cradle.
- [ ] **Body v2:** close the old USB-C slot (optional) and add a zero index mark. The existing LED hole is reused.
- [ ] **Disk v2:** a matching index notch.
- [ ] Test fit, then update the BOM (longer M3 bolts) and the README.

**Done when:** the enclosure closes with everything inside, USB is reachable, and Wi-Fi and Bluetooth range are acceptable with the bottom plate on.

**MVP = Phases 1–4 + E.**

## Phase 5 (post-MVP): Firmware updates over Wi-Fi

- [ ] Upload firmware and the web UI from the browser, using the ESP32 `Update` API. The partition scheme chosen in Phase 1 already reserves the second app slot.
- [ ] Require a password for updates, and allow setting a WPA2 password on the AP. With an open AP, anyone nearby could otherwise reflash the device.

## Backlog (deferred)

- adjust RPM in real time  while the motor is moving
  - Confirmed 2026-10-21: spins (CW/CCW buttons) follow the slider live, but moves (±15/45/90, Rotate by, Go to) keep the speed they started with. The fix is small: on a `speed` command during a move, re-request the same target at the new speed.
- Hall sensor and magnet homing, for an absolute angle that survives power cycles.
- Capacitive touch controls (start/stop, direction) through the case wall.
- Lighting control beyond NeoPixels. Examples: a switched or dimmed USB output for a USB light, or a desk lamp on a smart plug (which would need the turntable to join a Wi-Fi network). Needs exploration first.
- IR shutter for dedicated cameras.
- USB-C connector in place of the DevKit's micro-USB, for example a USB-C panel socket in the body's old USB-C slot. v2 ships with micro-USB through the riser.

## Scrapped

- Nothing currently. (The captive portal was scrapped on 2026-10-13 and revived on 2026-10-16 for Phase W.)

## Decisions

| Date | Decision |
|---|---|
| 2026-10-13 | ESP-01S rejected as a cheaper substitute: only 4 usable GPIO (no serial or LED left over), 1 MB flash, no USB, and boot-strapping pin risks. |
| 2026-10-13 | Target the ESP32 DevKit V1; the user has several on hand. The Bluetooth shutter is the main reason, since the ESP8266 has no Bluetooth. |
| 2026-10-13 | Angle control ships without homing (session zero, Set zero, index mark). Homing goes to the backlog. |
| 2026-10-13 | Enclosure cost is not a constraint (PLA, FDM). Deferred hardware is not designed into the enclosure. |
| 2026-10-13 | Captive portal scrapped. OTA comes after the MVP and before backlog items. |
| 2026-10-14 | Toolchain pinned in the `esp32` profile of `code/WebTurntable/sketch.yaml`: core 3.3.12, ESP Async WebServer 3.12.1, Async TCP 3.5.0, ArduinoJson 7.4.3. The arduino-cli 0.34.0 bundled with IDE 2.2.1 is enough; no standalone install. |
| 2026-10-14 | Keep the Minimal SPIFFS scheme even though core 3.x gives it 128 KB of file system, not 190 KB. If the UI outgrows it, use gzipped assets or a custom `partitions.csv`. |
| 2026-10-14 | The mock server uses only Node built-ins, including a minimal WebSocket implementation, so it needs no `npm install`. It emulates v1 now; v2 comes in Phase 2. |
| 2026-10-14 | Board: 30-pin DOIT DevKit V1, 51.45 × 28.33 mm, 13 mm from the pin tips to the top of the shield. Headers are soldered, and there are four corner mounting holes 23.37 apart across the width. |
| 2026-10-14 | Wiring: crimped Dupont housings on the existing header pins of both the DevKit and the ULN2003 ([HARDWARE.md](HARDWARE.md#dupont-harness)). Measured from the top of the shield to the end of a housing: just under 22. With wire bend room, the riser is about 31. |
| 2026-10-14 | The DevKit's mounting holes are Ø3, for M2.5 screws into posts on the bottom plate. |
| 2026-10-14 | Phase 1 stores settings in NVS (`Preferences`) instead of a LittleFS file, as the v2 design planned, so web UI uploads keep them. |
| 2026-10-14 | Phase 1 switches to ArduinoJson 7 now, rather than adding Arduino_JSON to the profile only to drop it in Phase 2. |
| 2026-10-14 | CCW fixed by making `RotateDirection::CCW` 2, the value the UI already sends. The mock server follows the fixed firmware. |
| 2026-10-14 | Serial logs at 115200 baud, matching the ESP32 boot messages and `tools\flash.cmd monitor`. |
| 2026-10-15 | The access point address is 192.168.4.5 (set with `softAPConfig`), because the user's home router is 192.168.4.1. Phones get leases from 192.168.4.6. |
| 2026-10-15 | BOOT-button flashing is accepted for now. Hands-free flashing (another DevKit, access holes) is revisited before the enclosure closes. |
| 2026-10-15 | Phase 2 angles grow clockwise (positive = CW), like a compass. |
| 2026-10-15 | Web commands are queued and run in `loop()`, so all settings and motion requests live on one thread. |
| 2026-10-15 | Settings saves wait for the motor to be idle, because flash writes pause the step interrupt (`CONFIG_GPTIMER_ISR_IRAM_SAFE` is off in the core). (The exception that saved a spin from rest so it could resume was dropped on 2026-10-21.) |
| 2026-10-15 | Rotate by builds on the last target in degrees, so repeated presses don't add up half-step rounding. |
| 2026-10-15 | The mock server dropped the v1 protocol along with the v1 UI. |
| 2026-10-15 | The firmware announces `turntable.local` over mDNS (ESPmDNS, part of the core), so phones can use a name. The IP address stays as the fallback for phones without mDNS. Adds about 36 KB of flash (53% total). |
| 2026-10-14 | Power and programming go through the DevKit's micro-USB, via an opening in the riser. A USB-C connector is a backlog item. |
| 2026-10-14 | The shutter test target is an iPhone 16 with the default Camera app. |
| 2026-10-14 | The ESP8266 version is frozen at tag `v1-esp8266` and not maintained. |
| 2026-10-14 | Flash v2 with arduino-cli through `tools\flash.cmd`, not the Arduino IDE, to avoid a second ~6.5 GB core install ([FLASHING.md](FLASHING.md)). |
| 2026-10-14 | Single branch: v2 work goes on main (renamed from master). The `v2-esp32` branch was merged and deleted. |
| 2026-10-16 | The access point is too fiddly as the everyday connection: the phone loses internet, and so does a PC. Phase W moves to home Wi-Fi with captive-portal setup, and the access point becomes the fallback. No compile-time secrets file. |
| 2026-10-16 | Captive portal revived for Phase W setup (it was scrapped on 2026-10-13). |
| 2026-10-16 | Phase W reset: a dedicated push button on GPIO 22 (to GND, internal pull-up), held at power-up, plus "Change Wi-Fi network" in the control UI. |
| 2026-10-16 | If the saved network isn't found within 20 s at power-up, the turntable starts setup and keeps retrying the saved network. A Wi-Fi drop while running only reconnects, with no access point. |
| 2026-10-16 | The saved network is only replaced when a new one connects, so a reset or an abandoned setup can't strand the turntable. |
| 2026-10-16 | Setup is a small captive portal built on AsyncWebServer and the core's DNSServer, not WiFiManager (which needs the synchronous WebServer). |
| 2026-10-21 | A power loss never restarts a spin: the disk always starts stopped (v1 resumed it). Found in testing, where a resumed spin couldn't be stopped until Wi-Fi reconnected. Speed and the other settings are still restored. |
| 2026-10-21 | The CW and CCW buttons toggle: pressing the direction that's already spinning stops it (with a ramp), and pressing the other one reverses. They look the same as before. |
| 2026-10-21 | Status LED moved from GPIO 23 to GPIO 2, and the reset button from GPIO 22 to GPIO 4. With D4, D2, D15 and GND adjacent, one 4-pin housing carries both (D15 empty). D5, the user's suggestion, was ruled out: it's a strapping pin that outputs during boot, and the button is held at power-up. GPIO 2 is a strapping pin too, but it's safe as an LED output, which only pulls it gently low. |
| 2026-10-21 | Settings save during spins, not only when idle, so a speed change mid-spin survives a power cut (found in testing). Moves still wait for idle, because flash writes pause stepping. |
| 2026-10-21 | `HALF_STEPS_PER_REV` = 4096 (the 64:1 variant), from the 10-revolution test (about 4100 measured). A 3D-printed disk and a hand-measured mark don't justify a fractional value; a rerun checks for any residual. |
| 2026-10-21 | Max speed limit 25 RPM, default 20, from hardware tests. |
| 2026-10-21 | The iPhone not reopening the captive sheet on a rejoin is an iOS quirk: it remembers networks. It's documented with workarounds rather than fixed in firmware. |

## Open questions

The 2026-10-13 planning questions are answered (see Decisions, 2026-10-14).

1. **DevKit hole spacing along the length:** center to center, between the antenna-end and USB-end holes. The diameter (Ø3) and the spacing across the width (23.37) are known. Needed for the cradle posts in Phase E.
2. **Flashing once enclosed** (deferred by the user 2026-10-15; revisit before closing the enclosure): the DevKit needs BOOT held to flash, and the buttons are out of reach inside the enclosure. Tests show this board's DTR line never pulls GPIO0 low, so the usual 10 µF EN capacitor fix is unlikely to help. Options: another DevKit with working auto-reset (check it with a read-only test), access holes for BOOT and EN, or rely on Wi-Fi updates later. See [HARDWARE.md](HARDWARE.md#download-mode-and-the-boot-button).
