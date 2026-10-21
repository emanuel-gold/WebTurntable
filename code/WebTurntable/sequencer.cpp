#include "sequencer.h"
#include "config.h"

#include <cmath>

namespace
{
    // What the sequencer is doing. Move is a plain Rotate by or Go to.
    enum class Job : uint8_t
    {
        None,
        Move,
        Spin,
        Sweep
    };

    // Where a sweep is
    enum class SweepStage : uint8_t
    {
        Travel,     // Going to targetPos, one of the ends
        Dwell       // Waiting at an end
    };

    // Owned by loop()
    Job job = Job::None;
    float jobRpm = DEFAULT_RPM;
    StopAfter stopAfter = StopAfter::Never;
    unsigned long startMs = 0;
    unsigned long limitMs = 0;          // Time limit, for StopAfter::Minutes
    int32_t targetPos = 0;              // End of a counted spin, or the sweep end being travelled to
    Direction spinDir = Direction::CW;

    // Last move target, kept in degrees so repeated Rotate by presses don't add up rounding errors
    double moveTargetDeg = 0.0;
    int32_t moveTargetPos = 0;

    // Sweep ends in half-steps from zero, and progress
    int32_t sweepFromPos = 0;
    int32_t sweepToPos = 0;
    uint32_t dwellMs = 0;
    uint32_t cycleLimit = 0;            // For StopAfter::Count
    uint32_t cyclesDone = 0;
    bool approaching = false;           // Still on the way to the first end
    SweepStage stage = SweepStage::Travel;
    unsigned long dwellStartMs = 0;

    // Keep a value inside [low, high], replacing a value that isn't a number
    float clampFinite(float value, float low, float high, float fallback)
    {
        if (!std::isfinite(value))
        {
            return fallback;
        }
        return value < low ? low : (value > high ? high : value);
    }

    // Degrees to turn from one angle to another: the shortest way, or round clockwise or counter-clockwise
    double angleDelta(double fromDeg, double toDeg, MoveDirection dir)
    {
        double delta = fmod(toDeg - fromDeg, 360.0);
        if (delta < 0.0)
        {
            delta += 360.0;
        }
        if (dir == MoveDirection::Shortest && delta > 180.0)
        {
            delta -= 360.0;
        }
        else if (dir == MoveDirection::CCW && delta > 0.0)
        {
            delta -= 360.0;
        }
        return delta;
    }

    // Remember a new job's speed and time limit
    void startJob(Job type, float rpm, StopAfter after, float value)
    {
        job = type;
        jobRpm = rpm;
        stopAfter = after;
        startMs = millis();
        limitMs = after == StopAfter::Minutes ? (unsigned long)lroundf(value * 60000.0f) : 0;
    }

    // Start a plain move to an angle in degrees from zero
    void startMove(double targetDeg, float rpm)
    {
        startJob(Job::Move, rpm, StopAfter::Never, 0.0f);
        moveTargetDeg = targetDeg;
        moveTargetPos = motionDegreesToHalfSteps(targetDeg);
        motionMoveTo(moveTargetPos, rpm);
    }

    // Advance a sweep: arrive at an end, dwell, then head for the other end
    void stepSweep(MotionState state, bool timeUp)
    {
        if (stage == SweepStage::Travel)
        {
            if (state != MotionState::Idle)
            {
                return;
            }
            // Arrived. Coming back to the first end completes a cycle.
            if (!approaching && targetPos == sweepFromPos)
            {
                cyclesDone++;
            }
            approaching = false;
            if (stopAfter == StopAfter::Count && cyclesDone >= cycleLimit)
            {
                job = Job::None;
                return;
            }
            stage = SweepStage::Dwell;
            dwellStartMs = millis();
        }

        // Once time is up, a sweep stops at the next end it reaches
        if (timeUp)
        {
            job = Job::None;
            return;
        }
        if (millis() - dwellStartMs >= dwellMs)
        {
            targetPos = targetPos == sweepFromPos ? sweepToPos : sweepFromPos;
            stage = SweepStage::Travel;
            motionMoveTo(targetPos, jobRpm);
        }
    }
}

// Keep spin options inside the limits in config.h
void clampSpinOptions(SpinOptions &options)
{
    switch (options.stopAfter)
    {
        case StopAfter::Count:
            options.stopValue = clampFinite(options.stopValue, MIN_STOP_REVS, MAX_STOP_REVS, 1.0f);
            break;
        case StopAfter::Minutes:
            options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_STOP_MINUTES, 1.0f);
            break;
        default:
            // Unused while the spin has no limit, but kept for when one is picked
            options.stopAfter = StopAfter::Never;
            options.stopValue = clampFinite(options.stopValue, MIN_STOP_REVS, MAX_STOP_REVS, 1.0f);
            break;
    }
}

// Keep sweep options inside the limits in config.h
void clampSweepOptions(SweepOptions &options)
{
    options.fromDeg = clampFinite(options.fromDeg, -MAX_SWEEP_DEG, MAX_SWEEP_DEG, -30.0f);
    options.toDeg = clampFinite(options.toDeg, -MAX_SWEEP_DEG, MAX_SWEEP_DEG, 30.0f);
    if (options.dwellMs > MAX_DWELL_MS)
    {
        options.dwellMs = MAX_DWELL_MS;
    }
    switch (options.stopAfter)
    {
        case StopAfter::Count:
            options.stopValue = roundf(clampFinite(options.stopValue, 1.0f, MAX_SWEEP_CYCLES, 4.0f));
            break;
        case StopAfter::Minutes:
            options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_STOP_MINUTES, 1.0f);
            break;
        default:
            options.stopAfter = StopAfter::Never;
            options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_SWEEP_CYCLES, 4.0f);
            break;
    }
}

// Spin, ramping to the given speed, until STOP or the stop condition
void sequencerSpin(float rpm, Direction dir, const SpinOptions &options)
{
    startJob(Job::Spin, rpm, options.stopAfter, options.stopValue);
    spinDir = dir;
    if (options.stopAfter == StopAfter::Count)
    {
        // A move that ramps into the last revolution, so it lands back on the starting angle
        const double turns = dir == Direction::CW ? options.stopValue : -options.stopValue;
        targetPos = motionStatus().position + motionDegreesToHalfSteps(turns * 360.0);
        motionMoveTo(targetPos, rpm);
    }
    else
    {
        motionRun(rpm, dir);
    }
}

// Sweep between the two angles, going to the first one first. Returns false if they're the same.
bool sequencerSweep(float rpm, const SweepOptions &options)
{
    // The first end is the copy of From nearest the disk, and the other end is To - From beyond it
    const double here = motionHalfStepsToDegrees(motionStatus().position);
    const double fromDeg = here + angleDelta(here, options.fromDeg, MoveDirection::Shortest);
    const int32_t fromPos = motionDegreesToHalfSteps(fromDeg);
    const int32_t toPos = motionDegreesToHalfSteps(fromDeg + options.toDeg - options.fromDeg);
    if (fromPos == toPos)
    {
        return false;
    }

    startJob(Job::Sweep, rpm, options.stopAfter, options.stopValue);
    cycleLimit = options.stopAfter == StopAfter::Count ? (uint32_t)lroundf(options.stopValue) : 0;
    sweepFromPos = fromPos;
    sweepToPos = toPos;
    dwellMs = options.dwellMs;
    cyclesDone = 0;
    approaching = true;
    stage = SweepStage::Travel;
    targetPos = fromPos;
    motionMoveTo(targetPos, rpm);
    return true;
}

// Rotate by an angle, building on the last target so repeated presses add up exactly
void sequencerMoveBy(double deg, float rpm)
{
    // Build on the last target while that move is unfinished, or the disk still sits on it
    const MotionStatus status = motionStatus();
    const bool onLastTarget = (job == Job::Move && status.state == MotionState::Moving)
        || status.position == moveTargetPos;
    startMove((onLastTarget ? moveTargetDeg : motionHalfStepsToDegrees(status.position)) + deg, rpm);
}

// Go to an angle from zero, the shortest way or a chosen way
void sequencerMoveTo(double deg, MoveDirection dir, float rpm)
{
    const double here = motionHalfStepsToDegrees(motionStatus().position);
    startMove(here + angleDelta(here, deg, dir), rpm);
}

// Change the speed of whatever is running
void sequencerSetSpeed(float rpm)
{
    jobRpm = rpm;
    switch (job)
    {
        case Job::Move:
            motionMoveTo(moveTargetPos, rpm);
            break;

        case Job::Spin:
            if (stopAfter == StopAfter::Count)
            {
                motionMoveTo(targetPos, rpm);
            }
            else
            {
                motionRun(rpm, spinDir);
            }
            break;

        case Job::Sweep:
            // While dwelling, the next leg picks up the new speed
            if (stage == SweepStage::Travel)
            {
                motionMoveTo(targetPos, rpm);
            }
            break;

        case Job::None:
            break;
    }
}

// End the job and ramp down
void sequencerStop()
{
    job = Job::None;
    motionStop();
}

// End the job, stop now and switch the coils off
void sequencerHalt()
{
    job = Job::None;
    motionHalt();
}

// Make the current position zero. A running job keeps going to the same places.
void sequencerSetZero()
{
    // Targets are kept from zero, so they shift with it
    const int32_t shift = motionSetZero();
    targetPos -= shift;
    sweepFromPos -= shift;
    sweepToPos -= shift;
    moveTargetPos -= shift;
    moveTargetDeg -= motionHalfStepsToDegrees(shift);
}

// Advance the running job. Called from loop().
void handleSequencer()
{
    if (job == Job::None)
    {
        return;
    }

    const MotionState state = motionStatus().state;
    const bool timeUp = stopAfter == StopAfter::Minutes && millis() - startMs >= limitMs;

    switch (job)
    {
        case Job::Move:
            if (state == MotionState::Idle)
            {
                job = Job::None;
            }
            break;

        case Job::Spin:
            if (stopAfter == StopAfter::Count && state == MotionState::Idle)
            {
                // Landed after the last revolution
                job = Job::None;
            }
            else if (timeUp)
            {
                job = Job::None;
                motionStop();
            }
            break;

        case Job::Sweep:
            stepSweep(state, timeUp);
            break;

        case Job::None:
            break;
    }
}

// What's running, and how much is left
JobStatus sequencerStatus()
{
    JobStatus status = {};
    status.type = job == Job::Spin ? JobType::Spin : (job == Job::Sweep ? JobType::Sweep : JobType::None);
    if (status.type == JobType::None)
    {
        return status;
    }

    status.stopAfter = stopAfter;
    if (stopAfter == StopAfter::Minutes)
    {
        const unsigned long elapsed = millis() - startMs;
        status.secondsLeft = elapsed >= limitMs ? 0 : (limitMs - elapsed + 999) / 1000;
    }
    if (job == Job::Spin && stopAfter == StopAfter::Count)
    {
        status.revsLeft = fabsf((float)(targetPos - motionStatus().position)) / HALF_STEPS_PER_REV;
    }
    if (job == Job::Sweep)
    {
        status.cycle = cyclesDone + 1;
        if (stopAfter == StopAfter::Count)
        {
            status.cycles = cycleLimit;
        }
    }
    return status;
}
