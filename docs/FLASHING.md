# Flashing the ESP32

How to put the v2 firmware and web UI on the DevKit from Windows. One script does it all: `tools\flash.cmd`. It runs arduino-cli with the versions pinned in [`code/WebTurntable/sketch.yaml`](../code/WebTurntable/sketch.yaml), so what you flash is exactly what was compile-checked.

Run every command from the repo folder, in PowerShell, Command Prompt or Git Bash. The commands are the same everywhere. Git Bash also accepts forward slashes, for example `tools/flash.cmd all` or `-Sketch code/Basic`.

## One-time setup

1. **Arduino IDE 2.** The script uses the arduino-cli bundled with the IDE, or one on PATH, so there is nothing else to install.
2. **Download the core.** Run `tools\flash.cmd check` once. The first build downloads the ESP32 core and libraries (about 6.5 GB, a few minutes). Later builds are quick.
3. **USB driver.** Plug in the DevKit with a USB data cable, then run `tools\flash.cmd ports`. The DevKit shows up as a port with `Usb` = `True`. If no new port appears, install the driver for the USB chip on your board (the small chip next to the micro-USB socket):
   - CP2102 or CP2104 (marked SILABS): the Silicon Labs "CP210x USB to UART Bridge VCP" driver.
   - CH340 or CH9102: the WCH CH340/CH341 driver.

   If it still doesn't show up, try another cable; some micro-USB cables only charge.

## Flashing

| Command | When to use it |
|---|---|
| `tools\flash.cmd all` | First flash, or after pulling changes. Uploads the firmware, then the web UI. |
| `tools\flash.cmd firmware` | After C++ changes. Saved settings and the web UI are kept. |
| `tools\flash.cmd webui` | After changes in `code/WebTurntable/data/`. |
| `tools\flash.cmd check` | Compile only, without a board. |
| `tools\flash.cmd monitor` | Serial log at 115200 baud. Press Ctrl+C to exit. |
| `tools\flash.cmd ports` | List serial ports. |

- **Port:** picked automatically when exactly one USB serial device is plugged in. Bluetooth and built-in COM ports are never picked. Otherwise add the port, for example `tools\flash.cmd all -Port COM7`.
- **Dry run:** add `-WhatIf` to compile and build the web UI image without writing anything to the board.
- **Web UI uploads replace the whole file system.** Anything the firmware stores there (presets, from Phase 3) is erased. Settings kept in NVS survive.

When `all` finishes, a turntable with no saved network starts Wi-Fi setup. See [Connecting to your Wi-Fi](#connecting-to-your-wi-fi).

## Connecting to your Wi-Fi

The turntable joins your home Wi-Fi like a smart plug. Your phone and PC stay on your network, with internet.

**First time, or when the saved network isn't around:**

1. Power the turntable up. With no saved network it starts setup straight away. With a saved network it tries that for about 20 seconds first.
2. On your phone, go to Settings → Wi-Fi and join **`TURNTABLE`** (no password). A setup page opens by itself. If it doesn't, open `http://192.168.4.5` in the browser.
3. Pick your home network and enter its password. Only 2.4 GHz networks show up. For a hidden network, use **Other network…**.
4. When the page says **Connected**, wait about 30 seconds while the setup network closes and your phone goes back to your Wi-Fi. Then tap **Open the turntable**, or open `http://turntable.local`.

**After that:** the turntable joins your Wi-Fi at power-up, with no setup network. Open `http://turntable.local` from any phone or PC on your network, and bookmark it. If the name doesn't work, use the address the setup page showed. A DHCP reservation in your router keeps that address fixed.

**Without Wi-Fi (at a shoot):** on the setup page, tap **Use Turntable as an access point** at the bottom. You then control the turntable over the `TURNTABLE` network. If your iPhone asks, choose **Use Without Internet**, so it keeps cellular data. This isn't saved: the next power-up looks for your Wi-Fi again.

**Switching networks:** in the control page, open Settings and tap **Change Wi-Fi network** twice. Or hold the reset button while you power up. Either way, the old network stays saved until a new one connects.

### Motor test (no Wi-Fi)

`tools\flash.cmd firmware -Sketch code\Basic` uploads the Basic sketch. The motor turns clockwise at about 7 RPM, and the status LED lights. Use it to check the harness before flashing the full firmware. Flash the full firmware again afterwards with `tools\flash.cmd all`.

### First flash checklist

1. `tools\flash.cmd all`, then `tools\flash.cmd monitor`. Press the DevKit's **EN** button to restart it and see the whole boot log. The first time it should show `No saved Wi-Fi network: starting setup` and `Setup access point TURNTABLE started`. Once set up, it shows `Joined <your network> - http://turntable.local (<address>)`. The status LED stays lit.
2. Do the [first-time Wi-Fi setup](#connecting-to-your-wi-fi), then open `http://turntable.local` on your phone and on the PC, both on your home Wi-Fi. Set a speed, and try CW, CCW and STOP. The dial follows the disk, and the log shows `Settings saved:` once the disk has stopped.
3. Unplug USB, plug it back in, and reload the page. The speed and settings come back where you left them. The disk stays stopped, even if it was spinning when you unplugged.

### Phase 2 hardware checks

Put a piece of tape on the disk and a mark on the body next to it, so you can see whether it comes back to the same spot.

1. **Smooth start and stop:** spin CW at 5 RPM, then STOP. Speed should ramp up and down with no jerk. Try changing direction while spinning (CW, then CCW): it should slow, reverse and speed up again.
2. **360° return:** press **Set zero here**, then Rotate by `360`. The tape should land back on the mark, and the dial should read `0.0°`.
3. **10-revolution test:** Rotate by `3600` at 15 RPM (about 40 seconds). If the tape ends up off the mark, note roughly how far and in which direction. That measures the real steps per revolution.
4. **Max speed:** the firmware caps speed at 20 RPM. Spin at 20 in both half-step and full-step, watching for buzzing, stalling, or the tape drifting off the mark after a Rotate by 360. Measured 2026-10-21: half-step was clean up to 25, full-step stalled at 25, and both stalled at 30.
5. **Two phones:** open the page on two phones (or a phone and the PC). Moves made on one should show live on the other's dial.
6. **Quick nudges:** press +15° several times quickly. The moves should add up into one smooth motion, and land exactly on a multiple of 15°.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No USB serial port found` | Check the cable and driver ([setup step 3](#one-time-setup)), or try another USB port on the PC. |
| Stuck at `Connecting....`, then `Failed to connect to ESP32: Wrong boot mode detected (0x13)` or a timeout | The board didn't enter download mode by itself. Hold the **BOOT** button on the DevKit, run the command again, and release BOOT once `Writing at 0x...` appears. `all` uploads twice, so hold it for each upload. The current DevKit needs this every time; see [HARDWARE.md](HARDWARE.md#download-mode-and-the-boot-button) for the fix. |
| `Download mode successfully detected, but getting no sync reply: The serial TX path seems to be down` | The board's output reaches the PC, but nothing gets back to it on RX0 (GPIO3). First unplug the USB cable, plug it back in, and retry with BOOT held; that cleared it on 2026-10-15. If it persists, unplug everything from the DevKit except USB, keep it off conductive surfaces, and try again, then try another DevKit. |
| `turntable.local` doesn't load at home | Check that the phone or PC is on the same network as the turntable. Guest networks often keep devices apart. Then try the address from the setup page, or the one in the serial log line `Joined …`. |
| The setup page doesn't open after joining `TURNTABLE` | iOS remembers networks it has joined before, and may skip the sign-in sheet on a rejoin. Open `http://192.168.4.5` (or any `http://` address) in Safari, or forget `TURNTABLE` in Settings → Wi-Fi and join it again. |
| The turntable keeps coming up in setup | It didn't find the saved network within 20 seconds. Check the router is on, and that its 2.4 GHz band is enabled. While nobody is on the setup network, the turntable retries the saved network every minute and switches over once it's found. |
| The setup page loses contact while joining | That's normal for a moment, because the setup network changes channel to match yours. The page carries on by itself. If it doesn't come back, rejoin your home Wi-Fi and open `http://turntable.local`. |
| In access point mode the phone drops `TURNTABLE` | The phone left the network because it has no internet. On an iPhone, choose **Use Without Internet** when asked. |
| `Could not open COM7, the port is busy` | Close whatever has the port open: the serial monitor (this script's or the Arduino IDE's), or another terminal. |
| The status LED blinks (half a second on, half a second off) and there's no Wi-Fi | The firmware stopped at a startup error. `tools\flash.cmd monitor`, then press **EN**, shows which one. Most often the web UI is missing: run `tools\flash.cmd webui`. |
| `turntable.local` doesn't load, but the IP address does | The phone doesn't support mDNS names (some Android phones), or it's sending lookups over cellular. Use the IP address. |
| Blank page or 404 | The web UI isn't on the board. Run `tools\flash.cmd webui`. |
| The board keeps resetting, and the log shows `Brownout detector was triggered` | Power problem. See [HARDWARE.md](HARDWARE.md#power): the 470 µF capacitor, and a 1 A supply. |
| In Git Bash, `tools/flash.cmd monitor` shows nothing, or Ctrl+C doesn't stop it | The standalone Git Bash window doesn't always pass console input and output through. Run `winpty tools/flash.cmd monitor` there, or use the Git Bash terminal inside VS Code. |
| PowerShell says running scripts is disabled | Use `tools\flash.cmd`, not `flash.ps1`. The `.cmd` wrapper bypasses the policy for that one run without changing any settings. |

## What the script runs

For reference, or for flashing by hand:

- **Firmware:** `arduino-cli compile --profile esp32 --upload --port COM7 code/WebTurntable`. This writes the bootloader, partition table and app.
- **Web UI:** `mklittlefs` packs `data/` into an image the size of the file system partition (128 KB at `0x3D0000` with the Minimal SPIFFS scheme). Then `esptool ... write-flash -z 0x3D0000 image.bin` writes it.
  - Both tools come with the ESP32 core. The script finds them through arduino-cli's build properties.
  - It reads the partition offset and size from the core's partition table, or from `code/WebTurntable/partitions.csv` if one is added later.
- **Serial monitor:** `arduino-cli monitor --port COM7 --config baudrate=115200`.
