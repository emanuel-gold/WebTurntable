# Hardware (v2, ESP32)

## Parts

| Part | Notes |
|---|---|
| ESP32 DevKit V1 (ESP-WROOM-32) | Replaces the Wemos D1 mini. |
| ULN2003 stepper driver board | Unchanged. |
| 28BYJ-48 stepper, 5 V | Unchanged. Direct drive: the disk sits on the motor shaft. |
| 3 mm LED + 220 Ω resistor | Status LED, using the body's existing LED hole. |
| 470 µF electrolytic capacitor, ≥10 V | Across 5 V and GND at the ULN2003 board. Stops ESP32 brownout resets when the coils switch. |
| Fasteners | Same as v1, except the 3 bottom-plate M3 bolts are longer by the riser height ([ENCLOSURE.md](ENCLOSURE.md)). |

Deferred hardware (hall sensor, touch pads, lighting, IR) is listed in the [roadmap backlog](ROADMAP.md#backlog-deferred) and is not designed in yet.

## Pin map (DOIT DevKit V1, 30-pin)

Check this against your board's silkscreen. The 38-pin variant has a different header order.

| Function | GPIO |
|---|---|
| ULN2003 IN1 | 33 |
| ULN2003 IN2 | 25 |
| ULN2003 IN3 | 26 |
| ULN2003 IN4 | 27 |
| Status LED (through 220 Ω) | 23 |
| Onboard blue LED | 2 (already on the board; usable as a second indicator) |
| ULN2003 + / − | VIN / GND (VIN carries USB 5 V) |

GPIO 33, 25, 26 and 27 sit next to each other on the left header, so one 4-pin Dupont housing covers IN1–IN4. None of them are strapping pins, and none of them toggle during boot, so the coils don't twitch at power-up.

**Pins to avoid:**

- 0, 2, 5, 12, 15: strapping pins that set the boot mode.
- 6–11: used by the module's flash.
- 1 and 3: serial.
- 14: outputs PWM during boot.
- 34–39: input-only.
- ADC2 pins: no analog reads while Wi-Fi is running.

**Reserved for backlog (not wired):** touch on 32, 4, 13; hall sensor on 34 or 35 (needs an external pull-up).

## Power

- Use one USB supply rated at least 1 A, plugged into the DevKit's micro-USB. The motor takes its 5 V from VIN.
- Budget: the motor draws roughly 100–200 mA (one or two coils on). The ESP32 averages roughly 100–250 mA with Wi-Fi and Bluetooth active, with short peaks above that. A computer's USB 2.0 port (500 mA) is marginal.
- Many DevKit boards have a diode between USB and VIN, so the motor sees about 4.7 V. That costs a little torque, which is fine in practice. Check your board before feeding 5 V into VIN while USB is also plugged in.
- If the ESP32 resets when the motor starts (serial shows `Brownout detector was triggered`), the 470 µF capacitor at the ULN2003 board is the first fix.

## Wiring

```
USB 5 V ── DevKit VIN ────────── ULN2003 +
DevKit GND ───────────────────── ULN2003 −
GPIO 33 / 25 / 26 / 27 ───────── ULN2003 IN1 / IN2 / IN3 / IN4
GPIO 23 ── 220 Ω ── LED anode;   LED cathode ── GND
28BYJ-48 ─────────────────────── ULN2003 5-pin socket (unchanged)
470 µF across ULN2003 + and −   (observe polarity)
```

## Logic levels

ESP32 GPIO runs at 3.3 V, the same as the D1 mini. The ULN2003 inputs switch reliably from 3.3 V, so no level shifting is needed.
