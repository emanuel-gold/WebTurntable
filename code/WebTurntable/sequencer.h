#ifndef SEQUENCER_H
#define SEQUENCER_H

#include <Arduino.h>

#include "motion.h"
#include "shutter.h"

// When a spin or sweep ends by itself
enum class StopAfter : uint8_t
{
    Never = 0,      // Runs until STOP
    Count = 1,      // Revolutions for a spin, cycles for a sweep
    Minutes = 2
};

// The job that's running, and a preset's mode. A plain move isn't a job.
enum class JobType : uint8_t
{
    None = 0,
    Spin = 1,
    Sweep = 2,
    Photo = 3,
    Video = 4
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

// Photo capture: shots a step apart, each taken with the disk still
struct PhotoOptions
{
    uint16_t shots = 36;
    float stepDeg = 10.0f;
    uint32_t settleMs = 800;        // Disk still before each shot
    uint32_t afterMs = 500;         // After each shot, before moving on
    Direction dir = Direction::CW;
    bool returnToStart = true;
    bool pressShutter = true;       // Off for a dry run
    uint32_t delayMs = 5000;        // Before the first shot: time to open the camera app
};

// Video capture: start recording, run the Spin or Sweep options' motion, stop recording
struct VideoOptions
{
    JobType motion = JobType::Spin;     // Spin or Sweep
    Direction dir = Direction::CW;      // For a spin
    uint32_t leadInMs = 1000;           // Recording before the motion starts
    uint32_t leadOutMs = 1000;          // Recording after it ends
    uint32_t delayMs = 5000;            // Before recording starts: time to open the camera app
};

// Which way a Go to angle move turns
enum class MoveDirection : uint8_t
{
    Shortest,
    CW,
    CCW
};

// Where a photo or video capture is
enum class CaptureStage : uint8_t
{
    Delay,      // Waiting before the first shot or the recording
    Move,       // Photo: turning to the next shot
    Settle,     // Photo: letting the disk settle before a shot
    Shot,       // Photo: just pressed the shutter, waiting before moving on
    Return,     // Photo: going back to the start
    LeadIn,     // Video: recording before the motion
    Motion,     // Video: the spin or sweep
    LeadOut     // Video: recording after the motion
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
    // Photo and video only
    CaptureStage stage;
    uint32_t startsIn;          // Seconds left of the start delay
    uint16_t shot;              // Photo: the shot in progress, from 1
    uint16_t shots;
    bool paused;
    bool needsShutter;          // Paused because no phone was ready for a shutter press
    JobType motion;             // Video: Spin or Sweep. During the motion, the fields above describe it.
};

// Keep options inside the limits in config.h
void clampSpinOptions(SpinOptions &options);
void clampSweepOptions(SweepOptions &options);
void clampPhotoOptions(PhotoOptions &options);
void clampVideoOptions(VideoOptions &options);

// Spin, ramping to the given speed, until STOP or the stop condition
void sequencerSpin(float rpm, Direction dir, const SpinOptions &options);

// Sweep between the two angles, going to the first one first. Returns false if they're the same.
bool sequencerSweep(float rpm, const SweepOptions &options);

// Take photos a step apart, pressing the shutter with the disk still. Returns an error, or nullptr.
const char* sequencerPhoto(float rpm, const PhotoOptions &options, ShutterKey key);

// Record a video of a spin or sweep: press, lead-in, motion, lead-out, press. Returns an error, or nullptr.
const char* sequencerVideo(float rpm, const VideoOptions &options, const SpinOptions &spin,
    const SweepOptions &sweep, ShutterKey key);

// Pause a photo capture before its next shot or move. Returns false if none is running.
bool sequencerPause();

// Carry on with a paused capture. Returns false if none is paused.
bool sequencerResume();

// Rotate by an angle, building on the last target so repeated presses add up exactly
void sequencerMoveBy(double deg, float rpm);

// Go to an angle from zero, the shortest way or a chosen way
void sequencerMoveTo(double deg, MoveDirection dir, float rpm);

// Change the speed of whatever is running
void sequencerSetSpeed(float rpm);

// End the job and ramp down. A video that's recording gets a last shutter press to stop it.
void sequencerStop();

// End the job, stop now and switch the coils off. A video that's recording gets a last shutter press.
void sequencerHalt();

// Make the current position zero. A running job keeps going to the same places.
void sequencerSetZero();

// Advance the running job. Called from loop().
void handleSequencer();

// What's running, and how much is left
JobStatus sequencerStatus();

#endif // SEQUENCER_H
