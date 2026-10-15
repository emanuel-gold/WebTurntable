#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// Pin definitions for the ESP32 DevKit V1 (see docs/HARDWARE.md)
const uint8_t MOTOR_PINS[] = {33, 25, 26, 27};  // ULN2003 IN1-IN4
const uint8_t LED_PIN = 23;                     // Status LED through 220 ohm, active high

// 28BYJ-48 gear ratio ~63.684:1, so one revolution of the disk is 2037.886 full steps
constexpr float HALF_STEPS_PER_REV = 4075.772f;

// Speed limits in RPM. maxRpm is a user setting between MIN_RPM and MAX_RPM_LIMIT.
constexpr float MIN_RPM = 0.5f;
constexpr float MAX_RPM_LIMIT = 30.0f;
constexpr float DEFAULT_MAX_RPM = 15.0f;
constexpr float DEFAULT_RPM = 5.0f;

// Acceleration in RPM per second, a user setting
constexpr float MIN_ACCEL = 1.0f;
constexpr float MAX_ACCEL = 200.0f;
constexpr float DEFAULT_ACCEL = 20.0f;

// Speed the motor starts from and stops at without a ramp
constexpr float START_RPM = 1.0f;

#endif // CONFIG_H
