# Roadmap: v2 (ESP32)

Goal: move WebTurntable from the ESP8266 (Wemos D1 mini) to an ESP32 DevKit V1. The extra capability goes into smoother motion, angle control and a Bluetooth camera shutter, so the turntable becomes a tool for product photos and turntable video.

Mark items `[x]` as they land.

## Status

_Last updated 2026-10-14._

- **Done:** planning and Phase 0.
  - v1 is frozen at tag `v1-esp8266`.
  - `code/WebTurntable/sketch.yaml` pins the ESP32 core and libraries. A test sketch compiles with the IDE-bundled arduino-cli.
  - The mock server in `tools/mock-server/` emulates the v1 protocol and has been checked in a browser against the current UI.
  - `tools\flash.cmd` compiles and flashes with arduino-cli ([FLASHING.md](FLASHING.md)). Port detection and the web UI image build are tested; uploading to a board isn't, because no v2 firmware exists yet.
  - The planning questions are answered (see Decisions, 2026-10-14).
- **No v2 firmware yet.** `code/` is still the v1 ESP8266 firmware. Only the UI's WebSocket URL changed (`location.host`, for the mock).
- **Next:** Phase 1. The first real flash also tests `tools\flash.cmd all` on hardware. Phase E can start once the two remaining [open questions](#open-questions) (mounting holes, Dupont stack height) are measured.
- **Working style:**
  - Work on master. v1 stays reproducible at tag `v1-esp8266`.
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
| Scrapped | Captive portal | — |

### Angle control without homing

Angle control works without homing. The firmware counts every step, so relative moves ("rotate by 10°") are exact as long as the motor doesn't skip steps. Acceleration ramps and a sensible max speed make skipping unlikely. Absolute angles are measured from a session zero: the position at power-up, or wherever the user presses **Set zero**.

Homing would add a zero that survives power cycles and turning the disk by hand. Until then, a printed index mark on the disk and body (Phase E) gives a repeatable manual zero.

## Phase 0: Prep

- [x] Tag master `v1-esp8266` before any v2 code change, so D1 mini builds stay reproducible.
- [x] Get arduino-cli working on the build PC (standalone, or the copy bundled with Arduino IDE 2) with ESP32 core 3.x and the v2 libraries ([FIRMWARE.md](FIRMWARE.md#toolchain)). Pin core and library versions in `sketch.yaml` so firmware can be compile-checked before flashing.
- [x] Add a Node mock server (`tools/mock-server/`) that serves `data/` and fakes the WebSocket protocol, so the UI can be built and tested in a browser without hardware.
- [x] Answer the planning questions: board variant, wiring method, USB/power, shutter test phone, the ESP8266 version, and how to flash (see Decisions, 2026-10-14).
- [x] Flash script and instructions for arduino-cli: `tools\flash.cmd`, [FLASHING.md](FLASHING.md).

## Phase 1: ESP32 port (parity)

Same features as v1, running on the DevKit.

- [ ] ESP32 includes (`WiFi.h`, `AsyncTCP.h`), the pin map from [HARDWARE.md](HARDWARE.md), and the partition scheme from [FIRMWARE.md](FIRMWARE.md#toolchain).
- [ ] Fix the CCW direction mismatch (UI sends `2`, firmware expects `3`).
- [ ] Status LED on the new pin, with the same error blink as v1.
- [ ] Update the README build instructions for ESP32, pointing to [FLASHING.md](FLASHING.md).

**Done when:** the existing UI drives the motor on the DevKit, and settings survive a power cycle.

## Phase 2: Motion engine and core UI

- [ ] Hardware-timer step generation that replaces `delayMicroseconds` in `loop()`, with a position counter in half-steps.
- [ ] Trapezoidal acceleration and deceleration on start, stop, and speed or direction changes.
- [ ] Drive modes: half-step (smooth, default) and two-phase full-step (more torque). Two-phase full-step replaces v1's one-coil "full" pattern.
- [ ] Coils off when idle, as in v1.
- [ ] Verify steps per revolution with a 10-revolution test against the index mark (expected 2037.886 full steps).
- [ ] Speed set in RPM, with seconds per revolution shown alongside. Make the slider linear in RPM, and find the real max reliable speed on hardware (v1 tops out around 16 RPM).
- [ ] Angle control: live angle dial, Set zero, Rotate by (quick ± buttons and a custom value), Go to angle (shortest path or a chosen direction).
- [ ] WebSocket protocol v2 ([FIRMWARE.md](FIRMWARE.md#websocket-protocol-v2-draft)) and UI rework: direction as buttons, plus an always-visible STOP.
- [ ] Stretch experiment: PWM microstepping through the ULN2003 (ESP32 LEDC) for quieter low-speed motion. Keep it only if it is clearly better.

**Done when:** start and stop look smooth, a 360° Rotate by returns to the same mark, and two phones show the angle updating live.

## Phase 3: Modes, timer, presets

- [ ] Back-and-forth (sweep): range or two end angles, speed, dwell at the ends, cycle count.
- [ ] Stop conditions for spin and sweep: after N revolutions or cycles, or after T minutes. The UI shows what remains.
- [ ] Presets: save the current mode and parameters under a name, then apply or delete it (about 10 slots). Store them somewhere a web UI upload doesn't erase ([FIRMWARE.md](FIRMWARE.md#persistence)).
- [ ] Persist the last-used state with the debounced write kept from v1.

**Done when:** a saved preset still reproduces the same motion after a reboot.

## Phase 4: Bluetooth shutter and capture

- [ ] Spike: pick a BLE HID library that works with arduino-esp32 3.x alongside the Wi-Fi AP and AsyncWebServer. Check flash and RAM fit, and test pairing with the iPhone 16 and its default Camera app.
- [ ] Shutter: the device advertises as a BLE keyboard and sends Volume Up (key configurable). The UI shows paired/connected state and has a **Test shutter** button.
- [ ] Photo capture: shots per revolution (or a step angle), settle delay before each shot, wait after each shot, direction, and return to start. The UI shows progress and estimated total time, with pause and cancel.
- [ ] Video capture: shutter press, then the motion (one revolution, a sweep, or a timed spin), then a second press. Lead-in and lead-out delays.

**Done when:** a 36-shot capture runs unattended and leaves 36 photos on the phone, and a one-revolution video starts and stops on its own.

## Phase E: Enclosure v2 (alongside Phases 1–4)

Approach and measurements are in [ENCLOSURE.md](ENCLOSURE.md).

- [ ] Measure the DevKit and choose the wiring method; together these set the riser height. Board measured and Dupont chosen (2026-10-14). Still needed: [open questions](#open-questions) 1–2.
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

- Hall sensor and magnet homing, for an absolute angle that survives power cycles.
- Capacitive touch controls (start/stop, direction) through the case wall.
- Lighting control beyond NeoPixels. Examples: a switched or dimmed USB output for a USB light, or a desk lamp on a smart plug (which would need the turntable to join a Wi-Fi network). Needs exploration first.
- IR shutter for dedicated cameras.
- USB-C connector in place of the DevKit's micro-USB, for example a USB-C panel socket in the body's old USB-C slot. v2 ships with micro-USB through the riser.

## Scrapped

- Captive portal.

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
| 2026-10-14 | The mock server uses only Node built-ins, including a minimal WebSocket implementation, so neither PC needs `npm install`. It emulates v1 now; v2 comes in Phase 2. |
| 2026-10-14 | Board: 30-pin DOIT DevKit V1, 51.45 × 28.33 mm, 13 mm from the pin tips to the top of the shield. Headers are soldered, and there are four corner mounting holes 23.37 apart across the width. |
| 2026-10-14 | Wiring: crimped Dupont housings on the existing header pins of both the DevKit and the ULN2003 ([HARDWARE.md](HARDWARE.md#dupont-harness)). The riser is about 27 mm. |
| 2026-10-14 | Power and programming go through the DevKit's micro-USB, via an opening in the riser. A USB-C connector is a backlog item. |
| 2026-10-14 | The shutter test target is an iPhone 16 with the default Camera app. |
| 2026-10-14 | The ESP8266 version is frozen at tag `v1-esp8266` and not maintained. |
| 2026-10-14 | Flash v2 with arduino-cli through `tools\flash.cmd`, not the Arduino IDE, to avoid a second ~6.5 GB core install ([FLASHING.md](FLASHING.md)). |
| 2026-10-14 | Single branch: v2 work goes on master. The `v2-esp32` branch was merged and deleted. |

## Open questions

The 2026-10-13 planning questions are answered (see Decisions, 2026-10-14). These measurements block Phase E:

1. **DevKit mounting holes:** the hole diameter, and the center-to-center spacing along the board's length. The spacing across the width (23.37) is known from the dimension drawing. These set the cradle posts.
2. **Dupont stack height:** with a crimped housing pushed onto a header pin, the distance from the top of the WROOM shield to the end of the housing. It sets the riser height ([ENCLOSURE.md](ENCLOSURE.md#riser-ring)).
