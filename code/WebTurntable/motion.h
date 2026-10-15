#ifndef MOTION_H
#define MOTION_H

#include <Arduino.h>

// Rotation direction, looking down at the disk. Angles grow clockwise.
enum class Direction : uint8_t
{
    CW = 0,
    CCW = 1
};

// Half-step moves one table entry per step; full-step uses two-coil steps for more torque
enum class DriveMode : uint8_t
{
    Half = 0,
    Full = 1
};

// What the motion engine is doing
enum class MotionState : uint8_t
{
    Idle,       // Coils off
    Running,    // Continuous spin (ramping or at speed)
    Moving,     // Going to a target position
    Stopping    // Ramping down to idle
};

// Snapshot of the motion engine for the UI
struct MotionStatus
{
    MotionState state;
    int32_t position;   // Half-steps from the session zero, positive clockwise
    float angleDeg;     // 0 to 360, clockwise from the session zero
    float speedRpm;     // Current speed, positive clockwise
};

// Set up the coil pins, the step timer and the control task
void motionBegin();

// Spin continuously, ramping to the given speed and direction
void motionRun(float rpm, Direction dir);

// Go to an absolute position in half-steps, at up to the given speed
void motionMoveTo(int32_t position, float rpm);

// Ramp down to a stop
void motionStop();

// Stop immediately and switch the coils off
void motionHalt();

// Make the current position the zero angle
void motionSetZero();

// Change the drive mode; takes effect on the next step
void motionSetDriveMode(DriveMode mode);

// Change the acceleration used by all ramps
void motionSetAcceleration(float rpmPerSecond);

// Current position, angle, speed and state
MotionStatus motionStatus();

// Degrees for a position in half-steps, without wrapping
double motionHalfStepsToDegrees(int32_t halfSteps);

// Half-steps for an angle in degrees (positive clockwise)
int32_t motionDegreesToHalfSteps(double degrees);

#endif // MOTION_H
