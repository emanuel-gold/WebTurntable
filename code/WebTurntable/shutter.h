#ifndef SHUTTER_H
#define SHUTTER_H

#include <Arduino.h>

// The key a shutter press sends. Stock camera apps take a photo, or start and stop recording, on either.
enum class ShutterKey : uint8_t
{
    VolumeUp = 0,
    VolumeDown = 1
};

// Snapshot of the Bluetooth shutter for the UI
struct ShutterStatus
{
    bool enabled;       // Advertising or connected; off means the radio stays quiet
    bool connected;     // A phone is connected
    bool ready;         // Connected, paired, and listening for key presses
};

// Start the Bluetooth stack as a BLE remote named "Turntable Shutter", advertising if enabled
void shutterBegin(bool enabled);

// Start or stop advertising. Turning it off also drops the connected phone.
void shutterSetEnabled(bool enabled);

// Press and release a key on the connected phone. Returns false if no phone is ready.
bool shutterPress(ShutterKey key);

// Release a pressed key once it has been held long enough. Called from loop().
void handleShutter();

// Current connection state
ShutterStatus shutterStatus();

// Drop the connected phone and forget every pairing, so a new phone can pair
void shutterForgetPhones();

#endif // SHUTTER_H
