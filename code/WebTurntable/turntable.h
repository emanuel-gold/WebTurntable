#ifndef TURNTABLE_H
#define TURNTABLE_H

#include <Arduino.h>

// Turntable pin definitions for the ESP32 DevKit V1 (see docs/HARDWARE.md)
const uint8_t MOTOR_PINS[] = {33, 25, 26, 27};  // ULN2003 IN1-IN4
const uint8_t LED_PIN = 23;                     // Status LED through 220 ohm, active high

// Describes the usable stepping delay range
#define MAX_DELAY 20000
#define MIN_DELAY 1800

// Webpage slider step count
#define TOTAL_SLIDER_STEPS 100

// Rotation direction states, matching the web UI's direction slider (0, 1, 2)
enum RotateDirection : uint8_t
{
    CW = 0,
    OFF = 1,
    CCW = 2
};

// Stepping mode determines the coil activation pattern and step sequence
enum RotateMode : uint8_t
{
    FULL_STEPPING = 0,
    HALF_STEPPING = 1
};

// Struct to hold the current turntable settings
struct TurntableSettings
{
    static constexpr uint32_t MAGIC = 0x5454424C;

    uint32_t magic              = MAGIC;
    RotateDirection direction   = RotateDirection::OFF;
    uint16_t sliderSpeed        = 0;
    RotateMode mode             = RotateMode::FULL_STEPPING;
};

// Global instance holding the turntable settings
extern TurntableSettings g_turntable;

// Main turntable control loop
void handleTurntable();

#endif // TURNTABLE_H