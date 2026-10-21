#ifndef SEQUENCER_H
#define SEQUENCER_H

#include <Arduino.h>

#include "motion.h"

// When a spin or sweep ends by itself
enum class StopAfter : uint8_t
{
    Never = 0,      // Runs until STOP
    Count = 1,      // Revolutions for a spin, cycles for a sweep
    Minutes = 2
};

// Spin options, kept with the settings and in presets
struct SpinOptions
{
    StopAfter stopAfter = StopAfter::Never;
    float stopValue = 1.0f;     // Revolutions or minutes
};

// Sweep options: back and forth between two angles from zero
struct SweepOptions
{
    float fromDeg = -30.0f;     // Not wrapped, so -30 is 30 degrees counter-clockwise of zero
    float toDeg = 30.0f;
    uint32_t dwellMs = 500;     // Pause at each end
    StopAfter stopAfter = StopAfter::Never;
    float stopValue = 4.0f;     // Cycles or minutes
};

// Which way a Go to angle move turns
enum class MoveDirection : uint8_t
{
    Shortest,
    CW,
    CCW
};

// The job that's running. A plain move isn't a job.
enum class JobType : uint8_t
{
    None = 0,
    Spin = 1,
    Sweep = 2
};

// Snapshot of the running job for the UI
struct JobStatus
{
    JobType type;
    StopAfter stopAfter;
    float revsLeft;             // Spin with a revolution count
    uint32_t secondsLeft;       // Spin or sweep with a time limit
    uint32_t cycle;             // Sweep: the cycle in progress, from 1
    uint32_t cycles;            // Sweep with a cycle count
};

// Keep options inside the limits in config.h
void clampSpinOptions(SpinOptions &options);
void clampSweepOptions(SweepOptions &options);

// Spin, ramping to the given speed, until STOP or the stop condition
void sequencerSpin(float rpm, Direction dir, const SpinOptions &options);

// Sweep between the two angles, going to the first one first. Returns false if they're the same.
bool sequencerSweep(float rpm, const SweepOptions &options);

// Rotate by an angle, building on the last target so repeated presses add up exactly
void sequencerMoveBy(double deg, float rpm);

// Go to an angle from zero, the shortest way or a chosen way
void sequencerMoveTo(double deg, MoveDirection dir, float rpm);

// Change the speed of whatever is running
void sequencerSetSpeed(float rpm);

// End the job and ramp down
void sequencerStop();

// End the job, stop now and switch the coils off
void sequencerHalt();

// Make the current position zero. A running job keeps going to the same places.
void sequencerSetZero();

// Advance the running job. Called from loop().
void handleSequencer();

// What's running, and how much is left
JobStatus sequencerStatus();

#endif // SEQUENCER_H
