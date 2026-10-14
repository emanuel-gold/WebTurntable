# Flashing the ESP32

How to put the v2 firmware and web UI on the DevKit from Windows. One script does it all: `tools\flash.cmd`. It runs arduino-cli with the versions pinned in [`code/WebTurntable/sketch.yaml`](../code/WebTurntable/sketch.yaml), so what you flash is exactly what was compile-checked.

Run every command from the repo folder, in PowerShell or Command Prompt.

## One-time setup

1. **Arduino IDE 2.** The script uses the arduino-cli bundled with the IDE, or one on PATH, so there is nothing else to install. The build PC already has it; the other PC would need it first.
2. **Download the core.** Run `tools\flash.cmd check` once. The first build downloads the ESP32 core and libraries (about 6.5 GB, a few minutes). Later builds are quick. This is already done on the build PC.
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

When `all` finishes, join the `TURNTABLE` Wi-Fi network on your phone and open `http://192.168.4.1`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No USB serial port found` | Check the cable and driver ([setup step 3](#one-time-setup)), or try another USB port on the PC. |
| Stuck at `Connecting....`, then `Failed to connect to ESP32` | Hold the **BOOT** button on the DevKit, run the command again, and release BOOT once `Writing at 0x...` appears. Some boards need this every time. |
| `Could not open COM7, the port is busy` | Close whatever has the port open: the serial monitor (this script's or the Arduino IDE's), or another terminal. |
| Blank page or 404 at 192.168.4.1, or the log says the file system failed to mount | The web UI isn't on the board. Run `tools\flash.cmd webui`. |
| The board keeps resetting, and the log shows `Brownout detector was triggered` | Power problem. See [HARDWARE.md](HARDWARE.md#power): the 470 µF capacitor, and a 1 A supply. |
| PowerShell says running scripts is disabled | Use `tools\flash.cmd`, not `flash.ps1`. The `.cmd` wrapper bypasses the policy for that one run without changing any settings. |

## What the script runs

For reference, or for flashing by hand:

- **Firmware:** `arduino-cli compile --profile esp32 --upload --port COM7 code/WebTurntable`. This writes the bootloader, partition table and app.
- **Web UI:** `mklittlefs` packs `data/` into an image the size of the file system partition (128 KB at `0x3D0000` with the Minimal SPIFFS scheme). Then `esptool ... write-flash -z 0x3D0000 image.bin` writes it.
  - Both tools come with the ESP32 core. The script finds them through arduino-cli's build properties.
  - It reads the partition offset and size from the core's partition table, or from `code/WebTurntable/partitions.csv` if one is added later.
- **Serial monitor:** `arduino-cli monitor --port COM7 --config baudrate=115200`.
