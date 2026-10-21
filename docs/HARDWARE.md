# Hardware (v2, ESP32)

## Parts

| Part | Notes |
|---|---|
| ESP32 DevKit V1 (ESP-WROOM-32), 30-pin | Replaces the Wemos D1 mini. 51.45 × 28.33 mm, 13 mm from the header pin tips to the top of the WROOM shield. Header rows are 25.40 mm apart, with male headers already soldered. Four corner mounting holes, with centers 23.37 mm apart across the width. Micro-USB. |
| ULN2003 stepper driver board | Unchanged. |
| 28BYJ-48 stepper, 5 V | Unchanged. Direct drive: the disk sits on the motor shaft. |
| 3 mm LED + 220 Ω resistor | Status LED, using the body's existing LED hole. |
| Momentary push button (normally open) | Reset: held at power-up, it starts Wi-Fi setup. Needs a hole in the enclosure (Phase E). |
| 470 µF electrolytic capacitor, ≥10 V | Across 5 V and GND at the ULN2003 board. Stops ESP32 brownout resets when the coils switch. |
| Fasteners | Same as v1, except the 3 bottom-plate M3 bolts are longer by the riser height ([ENCLOSURE.md](ENCLOSURE.md)). Add 4 × M2.5 screws for the DevKit's Ø3 mounting holes. |

Deferred hardware (hall sensor, touch pads, lighting, IR) is listed in the [roadmap backlog](ROADMAP.md#backlog-deferred) and is not designed in yet.

## Pin map (DOIT DevKit V1, 30-pin)

Check this against your board's silkscreen. The 38-pin variant has a different header order.

| Function | GPIO |
|---|---|
| ULN2003 IN1 | 33 |
| ULN2003 IN2 | 25 |
| ULN2003 IN3 | 26 |
| ULN2003 IN4 | 27 |
| Status LED (through 220 Ω) | 2 (shared with the onboard blue LED, which lights along with it) |
| Reset button (to GND, internal pull-up) | 4 |
| ULN2003 + / − | VIN / GND (VIN carries USB 5 V) |

GPIO 33, 25, 26 and 27 sit next to each other on the EN header, so one 4-pin Dupont housing covers IN1–IN4 ([harness](#dupont-harness)). None of them are strapping pins, and none of them toggle during boot, so the coils don't twitch at power-up.

**Pins to avoid:**

- 0, 2, 5, 12, 15: strapping pins that set the boot mode. GPIO 2 is used for the status LED anyway. It only matters when entering flashing mode, where it must be low or floating, and the LED with its resistor pulls it gently low. GPIO 5 and 15 also output a signal during boot, so they stay unconnected.
- 6–11: used by the module's flash.
- 1 and 3: serial.
- 14: outputs PWM during boot.
- 34–39: input-only.
- ADC2 pins: no analog reads while Wi-Fi is running.

**Reserved for backlog (not wired):** touch on 32, 13, 14; hall sensor on 34 or 35 (needs an external pull-up).

## Power

- Use one USB supply rated at least 1 A, plugged into the DevKit's micro-USB. The motor takes its 5 V from VIN.
- Budget: the motor draws roughly 100–200 mA (one or two coils on). The ESP32 averages roughly 100–250 mA with Wi-Fi and Bluetooth active, with short peaks above that. A computer's USB 2.0 port (500 mA) is marginal.
- Many DevKit boards have a diode between USB and VIN, so the motor sees about 4.7 V. That costs a little torque, which is fine in practice. Check your board before feeding 5 V into VIN while USB is also plugged in.
- If the ESP32 resets when the motor starts (serial shows `Brownout detector was triggered`), the 470 µF capacitor at the ULN2003 board is the first fix.

## Download mode and the BOOT button

- **The problem.** The current DevKit doesn't enter download mode on its own. Flashing fails with `Wrong boot mode detected (0x13)` unless BOOT is held (found 2026-10-15).
  - The USB chip's RTS line resets the chip fine.
  - The DTR line never pulls GPIO0 low. On 2026-10-15, custom esptool reset sequences held DTR asserted for up to 3 s after reset (read-only `chip-id` tests), and the chip still booted normally every time (boot mode 0x13). So this isn't a timing problem: the DTR-to-GPIO0 path (the line, its transistor, or the USB chip) doesn't work on this board.
- **Why it matters.** Inside the enclosure, the BOOT and EN buttons can't be reached. Before closing it up, pick one:
  - **Use another DevKit** whose auto-reset works. Check it with the same read-only test before wiring it in.
  - **10 µF capacitor between EN and GND:** the usual fix when auto-reset timing is marginal. It's unlikely to help here, because the timing tests failed even with long holds.
  - **Leave access holes** for BOOT and EN in the riser or bottom plate.
  - **Wi-Fi updates** (Phase 5), which only cover the firmware once it's running. A board stuck in a crash loop would still need USB with BOOT.

## Wiring

```
USB 5 V ── DevKit VIN ────────── ULN2003 +
DevKit GND ───────────────────── ULN2003 −
GPIO 33 / 25 / 26 / 27 ───────── ULN2003 IN1 / IN2 / IN3 / IN4
GPIO 2 ── 220 Ω ── LED anode;    LED cathode ── GND
GPIO 4 ── push button ── GND
28BYJ-48 ─────────────────────── ULN2003 5-pin socket (unchanged)
470 µF across ULN2003 + and −   (observe polarity)
```

### Dupont harness

Both the DevKit and the ULN2003 board have male header pins, so the wiring is a harness of crimped Dupont housings (1- to 7-pin housings are on hand).

Header positions follow the DOIT 30-pin layout (checked against the board's dimension drawing and pinout), viewed from the component side. One header starts with **EN** at the antenna end; the other starts with **D23**. Check against the silkscreen before crimping.

| Lead | DevKit end | Far end | Housings |
|---|---|---|---|
| Motor signals | D33, D25, D26, D27: pins 7–10 of the EN header, counting from EN | ULN2003 IN1, IN2, IN3, IN4 | 4-pin at both ends |
| Motor power | GND, VIN: the last two pins of the EN header, at the USB end | ULN2003 − and + | 2-pin at both ends |
| Status LED and reset button | D4, D2, D15, GND: four pins in a row near the USB end of the D23 header (pins 11–14). D15 stays empty. | One button lead on D4. The LED anode on D2, with the 220 Ω resistor soldered inline under heat-shrink. The LED cathode and the other button lead spliced into one GND lead. | One 4-pin housing, with the D15 position left empty |

- **Power polarity.** A 2-pin housing plugged in backwards reverses the ULN2003 supply. Mark the GND side of both housings. Before connecting the ULN2003, check with a multimeter that + reads about 4.7–5 V against −.
- **Capacitor.** Solder the 470 µF capacitor across the ULN2003 board's power pins on the underside, with the stripe (−) to −. Alternatively, splice it into the power lead at the ULN2003 end.
- **Power jumper.** If the ULN2003 board has a power on/off jumper next to its power pins, leave it fitted.
- **Reset button.** The firmware uses the internal pull-up, so the button just shorts GPIO 4 to GND. Hold it for about a second while plugging in power to start Wi-Fi setup. Don't use the DevKit's BOOT button for this: GPIO0 held at power-up enters flashing mode.
- **Lengths.** The DevKit sits in the riser below the body, and the ULN2003 hangs under the deck ([ENCLOSURE.md](ENCLOSURE.md)). Cut the leads once the riser is test-fitted.

## Logic levels

ESP32 GPIO runs at 3.3 V, the same as the D1 mini. The ULN2003 inputs switch reliably from 3.3 V, so no level shifting is needed.
