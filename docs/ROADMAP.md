# Roadmap: v2 (ESP32)

Goal: move WebTurntable from the ESP8266 (Wemos D1 mini) to an ESP32 DevKit V1. The extra capability goes into smoother motion, angle control and a Bluetooth camera shutter, so the turntable becomes a tool for product photos and turntable video.

Mark items `[x]` as they land.

## Status

_Last updated 2026-10-13._

- **Done:** planning. Scope, phases, hardware pin map, firmware design and enclosure approach are all written up; the enclosure STLs are measured.
- **No v2 code yet.** `code/` is still the v1 ESP8266 firmware.
- **Next:** Phase 0, then Phase 1. Phase 1 can start right away. Phase E is blocked on [open questions](#open-questions) 1–3 (board measurements, wiring method, USB/power), so ask the user before enclosure work.
- **Working style:**
  - Do code work on a branch (for example `v2-esp32`) after tagging `v1-esp8266`.
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

- [ ] Tag master `v1-esp8266` before any v2 code change, so D1 mini builds stay reproducible. Do v2 work on a branch.
- [ ] Get arduino-cli working on the build PC (standalone, or the copy bundled with Arduino IDE 2) with ESP32 core 3.x and the v2 libraries ([FIRMWARE.md](FIRMWARE.md#toolchain)). Pin core and library versions in `sketch.yaml` so firmware can be compile-checked before flashing.
- [ ] Add a Node mock server (`tools/mock-server/`) that serves `data/` and fakes the WebSocket protocol, so the UI can be built and tested in a browser without hardware.
- [ ] Answer the [open questions](#open-questions). Board measurements block the enclosure.

## Phase 1: ESP32 port (parity)

Same features as v1, running on the DevKit.

- [ ] ESP32 includes (`WiFi.h`, `AsyncTCP.h`), the pin map from [HARDWARE.md](HARDWARE.md), and the partition scheme from [FIRMWARE.md](FIRMWARE.md#toolchain).
- [ ] Fix the CCW direction mismatch (UI sends `2`, firmware expects `3`).
- [ ] Status LED on the new pin, with the same error blink as v1.
- [ ] Update the README build instructions for ESP32.

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
- [ ] Presets: save the current mode and parameters under a name, then apply or delete it (about 10 slots).
- [ ] Persist the last-used state with the debounced write kept from v1.

**Done when:** a saved preset still reproduces the same motion after a reboot.

## Phase 4: Bluetooth shutter and capture

- [ ] Spike: pick a BLE HID library that works with arduino-esp32 3.x alongside the Wi-Fi AP and AsyncWebServer. Check flash and RAM fit, and test pairing with the phones from [open question 4](#open-questions).
- [ ] Shutter: the device advertises as a BLE keyboard and sends Volume Up (key configurable). The UI shows paired/connected state and has a **Test shutter** button.
- [ ] Photo capture: shots per revolution (or a step angle), settle delay before each shot, wait after each shot, direction, and return to start. The UI shows progress and estimated total time, with pause and cancel.
- [ ] Video capture: shutter press, then the motion (one revolution, a sweep, or a timed spin), then a second press. Lead-in and lead-out delays.

**Done when:** a 36-shot capture runs unattended and leaves 36 photos on the phone, and a one-revolution video starts and stops on its own.

## Phase E: Enclosure v2 (alongside Phases 1–4)

Approach and measurements are in [ENCLOSURE.md](ENCLOSURE.md).

- [ ] Measure the DevKit and choose the wiring method; together these set the riser height.
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

## Open questions

1. **DevKit variant:** 30-pin or 38-pin? Measure length × width, the height with headers, and whether the board has mounting holes.
2. **Wiring:** Dupont jumpers (about a 27 mm riser) or wires soldered to the pins (about 15 mm)? See [ENCLOSURE.md](ENCLOSURE.md#riser-ring).
3. **Power and USB:** micro-USB on the DevKit through the riser wall (recommended: power and programming, no extra parts), or a USB-C panel socket in the old slot for power only?
4. **Shutter test phones:** which iPhone or Android models, and which camera apps?
5. **ESP8266 version:** freeze it at the `v1-esp8266` tag (assumed), or keep it maintained alongside v2?
