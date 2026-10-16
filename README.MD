# **WebTurntable**
A webpage controllable turntable project that I made during a free weekend. This repository contains the project code. Visit the [MakerWorld](https://makerworld.com/en/models/572900) page to get the 3D files.

This fork moves the turntable to an ESP32 (v2, work in progress; see the [roadmap](docs/ROADMAP.md)). The original ESP8266 (Wemos D1 mini) version is kept at the `v1-esp8266` tag.

## **Necessary components**
### **Electronics**
- ULN2003 stepper driver
- 28byj-48 (5V) motor
- ESP32 DevKit V1, 30-pin (ESP-WROOM-32, micro-USB)
- 3mm LED
- LED current limiting resistor (220 ohm)
- 470 µF electrolytic capacitor (10 V or more), across the ULN2003 power pins
- Momentary push button (resets the Wi-Fi setup)
- Dupont housings and crimp pins for the wiring harness

The pin map and harness are in [docs/HARDWARE.md](docs/HARDWARE.md).

### **Fasteners**
- 3x M3 threaded inserts
- 5x M3 bolts
- 2x M3 nuts
- 4x M2 bolts
- 4x M2 nuts

### **3D-printed parts**
- Disk
- Body
- Bottom plate

The ESP32 doesn't fit in the original body, so v2 adds a riser ring under it ([docs/ENCLOSURE.md](docs/ENCLOSURE.md)).

## **Compile and upload the code**
The code is based on the Arduino platform with the ESP32 core. It is compiled and uploaded with arduino-cli, using the core and library versions pinned in `sketch.yaml`. Arduino IDE 2 includes arduino-cli, so installing the IDE is enough.

On Windows, `tools\flash.cmd` does everything:
- `tools\flash.cmd all` uploads the firmware and the webpage.
- `tools\flash.cmd monitor` shows the serial log.

Step-by-step instructions and troubleshooting are in [docs/FLASHING.md](docs/FLASHING.md).

### **Basic example**
Simple code example that just rotates the turntable. It is also a quick wiring test: the motor turns clockwise and the LED lights. Upload it with `tools\flash.cmd firmware -Sketch code\Basic`.

### **WebTurntable**
The full version of the code. The turntable joins your Wi-Fi and serves a web interface for controlling it at `http://turntable.local`. The first time, it offers a setup network for choosing your Wi-Fi, like a smart plug.

The speed, direction, drive mode, acceleration and max speed are stored in the ESP32's flash (NVS) and loaded after a reboot or power cycle. A spin that was running when the power went off starts again. To prevent excessive wear on the flash memory, settings are written after a short idle delay (750 ms), once the disk has stopped. The webpage itself is stored separately in LittleFS, so uploading a new webpage keeps the settings.

The following additional libraries are used:
- [ESPAsyncWebServer](https://github.com/ESP32Async/ESPAsyncWebServer)
- [AsyncTCP](https://github.com/ESP32Async/AsyncTCP)
- [ArduinoJson](https://arduinojson.org/)

To connect the turntable the first time:
1. Power it up, then join the Wi-Fi network named `TURNTABLE` on your phone. A setup page opens (otherwise browse to `http://192.168.4.5`)
2. Pick your home Wi-Fi (2.4 GHz) and enter its password
3. When it says Connected, your phone goes back to your Wi-Fi. Open `http://turntable.local`

From then on it joins your Wi-Fi at power-up. Without Wi-Fi, choose "Use Turntable as an access point" on the setup page. To change networks, use Settings → Change Wi-Fi network, or hold the reset button while powering up. Details are in [docs/FLASHING.md](docs/FLASHING.md#connecting-to-your-wi-fi).
