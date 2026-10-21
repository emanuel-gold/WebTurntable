#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// Pin definitions for the ESP32 DevKit V1 (see docs/HARDWARE.md)
const uint8_t MOTOR_PINS[] = {33, 25, 26, 27};  // ULN2003 IN1-IN4
const uint8_t LED_PIN = 2;                      // Status LED through 220 ohm, active high (the onboard blue LED too)
const uint8_t RESET_BUTTON_PIN = 4;             // Push button to GND; held at power-up, starts Wi-Fi setup

// This motor is the exact 64:1 variant of the 28BYJ-48: 2048 full steps per revolution.
// Measured 2026-10-21: with the datasheet's 63.684:1 (4075.77 half-steps), ten revolutions
// stopped about 18.5 mm short at the 50 mm rim, which works out to about 4100 half-steps.
constexpr float HALF_STEPS_PER_REV = 4096.0f;

// Speed limits in RPM. maxRpm is a user setting between MIN_RPM and MAX_RPM_LIMIT.
constexpr float MIN_RPM = 0.5f;
// Measured 2026-10-21: 25 RPM is clean in half-step; full-step stalls at 25, and both stall at 30.
constexpr float MAX_RPM_LIMIT = 25.0f;
constexpr float DEFAULT_MAX_RPM = 20.0f;
constexpr float DEFAULT_RPM = 5.0f;

// Acceleration in RPM per second, a user setting
constexpr float MIN_ACCEL = 1.0f;
constexpr float MAX_ACCEL = 200.0f;
constexpr float DEFAULT_ACCEL = 20.0f;

// Speed the motor starts from and stops at without a ramp
constexpr float START_RPM = 1.0f;

#endif // CONFIG_H
