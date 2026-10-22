#include "sequencer.h"
#include "config.h"

#include <cmath>

namespace
{
    // What the motion layer is doing. Move is a plain Rotate by or Go to.
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

    // A capture runs on top of the motion layer, starting moves, spins and sweeps of its own
    enum class Capture : uint8_t
    {
        None,
        Photo,
        Video
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

    // Photo and video capture
    Capture capture = Capture::None;
    CaptureStage captureStage = CaptureStage::Delay;
    unsigned long stageStartMs = 0;
    bool paused = false;
    bool needsShutter = false;
    bool recording = false;             // Video: the first shutter press went through
    ShutterKey shutterKey = ShutterKey::VolumeUp;
    float captureRpm = DEFAULT_RPM;
    PhotoOptions photo;
    uint16_t shotIndex = 0;             // The shot in progress, from 0
    double photoStartDeg = 0.0;
    VideoOptions video;
    SpinOptions videoSpin;
    SweepOptions videoSweep;

    // Keep a value inside [low, high], replacing a value that isn't a number
    float clampFinite(float value, float low, float high, float fallback)
    {
        if (!std::isfinite(value))
        {
            return fallback;
        }
        return value < low ? low : (value > high ? high : value);
    }

    // Keep a capture wait within MAX_WAIT_MS
    uint32_t clampWait(uint32_t ms)
    {
        return ms > MAX_WAIT_MS ? MAX_WAIT_MS : ms;
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

    // Start a spin with its stop condition
    void startSpin(float rpm, Direction dir, const SpinOptions &options)
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

    // Where a sweep starting now would turn: the copy of From nearest the disk, and To - From
    // beyond it. Returns false if both land on the same half-step.
    bool sweepEnds(const SweepOptions &options, int32_t &fromPos, int32_t &toPos)
    {
        const double here = motionHalfStepsToDegrees(motionStatus().position);
        const double fromDeg = here + angleDelta(here, options.fromDeg, MoveDirection::Shortest);
        fromPos = motionDegreesToHalfSteps(fromDeg);
        toPos = motionDegreesToHalfSteps(fromDeg + options.toDeg - options.fromDeg);
        return fromPos != toPos;
    }

    // Start a sweep between ends from sweepEnds(), going to the first one first
    void startSweep(float rpm, const SweepOptions &options, int32_t fromPos, int32_t toPos)
    {
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

    // Advance the motion layer: notice when moves and counted spins land, and run sweeps and time limits
    void stepJob()
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

    // Fill in what's left of the running spin or sweep
    void addJobProgress(JobStatus &status)
    {
        if (job != Job::Spin && job != Job::Sweep)
        {
            return;
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
    }

    // Move a capture on to its next stage, restarting the stage timer
    void enterStage(CaptureStage next)
    {
        captureStage = next;
        stageStartMs = millis();
    }

    // Press the shutter for a capture. If no phone is ready, pause until the user resumes.
    bool pressCaptureShutter()
    {
        if (shutterPress(shutterKey))
        {
            return true;
        }
        Serial.println("Capture paused: no phone ready for the shutter");
        paused = true;
        needsShutter = true;
        return false;
    }

    // End a capture that ran to completion
    void finishCapture()
    {
        Serial.println(capture == Capture::Photo ? "Photo capture done" : "Video capture done");
        capture = Capture::None;
        paused = false;
    }

    // Drop a capture because something else is starting. A video that's recording gets a
    // last shutter press, so the camera doesn't keep recording.
    void cancelCapture()
    {
        if (capture == Capture::Video && recording)
        {
            shutterPress(shutterKey);
            Serial.println("Video capture cancelled: stopped the recording");
        }
        capture = Capture::None;
        recording = false;
        paused = false;
    }

    // Start a capture: end whatever was running and wait out the start delay
    void beginCapture(Capture type, float rpm, ShutterKey key)
    {
        cancelCapture();
        job = Job::None;
        motionStop();
        capture = type;
        captureRpm = rpm;
        shutterKey = key;
        paused = false;
        needsShutter = false;
        recording = false;
        shotIndex = 0;
        enterStage(CaptureStage::Delay);
    }

    // Advance a photo capture: settle, shoot, wait, turn one step, and again
    void stepPhoto(bool motionDone, unsigned long elapsed)
    {
        switch (captureStage)
        {
            case CaptureStage::Delay:
                if (paused || !motionDone || elapsed < photo.delayMs)
                {
                    return;
                }
                // The first shot is where the disk stands
                photoStartDeg = motionHalfStepsToDegrees(motionStatus().position);
                Serial.printf("Photo capture: %u shots, %.2f deg apart\n", photo.shots, photo.stepDeg);
                enterStage(CaptureStage::Settle);
                break;

            case CaptureStage::Move:
                if (motionDone)
                {
                    enterStage(CaptureStage::Settle);
                }
                break;

            case CaptureStage::Settle:
                if (paused || elapsed < photo.settleMs)
                {
                    return;
                }
                if (photo.pressShutter && !pressCaptureShutter())
                {
                    return;
                }
                Serial.printf("Photo %u of %u\n", shotIndex + 1, photo.shots);
                enterStage(CaptureStage::Shot);
                break;

            case CaptureStage::Shot:
                if (paused || elapsed < photo.afterMs)
                {
                    return;
                }
                shotIndex++;
                if (shotIndex < photo.shots)
                {
                    // Each target counts from the start, so steps don't add up rounding errors
                    const double sign = photo.dir == Direction::CW ? 1.0 : -1.0;
                    startMove(photoStartDeg + sign * shotIndex * photo.stepDeg, captureRpm);
                    enterStage(CaptureStage::Move);
                }
                else if (photo.returnToStart)
                {
                    // After a full turn, the short way back is one more step forward
                    const double here = motionHalfStepsToDegrees(motionStatus().position);
                    startMove(here + angleDelta(here, photoStartDeg, MoveDirection::Shortest), captureRpm);
                    enterStage(CaptureStage::Return);
                }
                else
                {
                    finishCapture();
                }
                break;

            case CaptureStage::Return:
                if (motionDone)
                {
                    finishCapture();
                }
                break;

            default:
                break;
        }
    }

    // Advance a video capture: press to record, lead-in, motion, lead-out, press to stop
    void stepVideo(bool motionDone, unsigned long elapsed)
    {
        switch (captureStage)
        {
            case CaptureStage::Delay:
                if (paused || !motionDone || elapsed < video.delayMs || !pressCaptureShutter())
                {
                    return;
                }
                recording = true;
                Serial.println("Video capture: recording");
                enterStage(CaptureStage::LeadIn);
                break;

            case CaptureStage::LeadIn:
                if (elapsed < video.leadInMs)
                {
                    return;
                }
                if (video.motion == JobType::Sweep)
                {
                    int32_t fromPos;
                    int32_t toPos;
                    if (sweepEnds(videoSweep, fromPos, toPos))
                    {
                        startSweep(captureRpm, videoSweep, fromPos, toPos);
                    }
                }
                else
                {
                    startSpin(captureRpm, video.dir, videoSpin);
                }
                enterStage(CaptureStage::Motion);
                break;

            case CaptureStage::Motion:
                if (motionDone)
                {
                    enterStage(CaptureStage::LeadOut);
                }
                break;

            case CaptureStage::LeadOut:
                if (elapsed < video.leadOutMs)
                {
                    return;
                }
                // Stop recording. If the phone has gone, there's nothing more to do.
                shutterPress(shutterKey);
                recording = false;
                finishCapture();
                break;

            default:
                break;
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

// Keep photo options inside the limits in config.h
void clampPhotoOptions(PhotoOptions &options)
{
    options.shots = options.shots < 1 ? 1 : (options.shots > MAX_PHOTO_SHOTS ? MAX_PHOTO_SHOTS : options.shots);
    options.stepDeg = clampFinite(options.stepDeg, MIN_PHOTO_STEP_DEG, MAX_PHOTO_STEP_DEG, 10.0f);
    options.settleMs = clampWait(options.settleMs);
    options.afterMs = clampWait(options.afterMs);
    options.delayMs = clampWait(options.delayMs);
    options.dir = options.dir == Direction::CCW ? Direction::CCW : Direction::CW;
}

// Keep video options inside the limits in config.h
void clampVideoOptions(VideoOptions &options)
{
    options.motion = options.motion == JobType::Sweep ? JobType::Sweep : JobType::Spin;
    options.dir = options.dir == Direction::CCW ? Direction::CCW : Direction::CW;
    options.leadInMs = clampWait(options.leadInMs);
    options.leadOutMs = clampWait(options.leadOutMs);
    options.delayMs = clampWait(options.delayMs);
}

// Spin, ramping to the given speed, until STOP or the stop condition
void sequencerSpin(float rpm, Direction dir, const SpinOptions &options)
{
    cancelCapture();
    startSpin(rpm, dir, options);
}

// Sweep between the two angles, going to the first one first. Returns false if they're the same.
bool sequencerSweep(float rpm, const SweepOptions &options)
{
    int32_t fromPos;
    int32_t toPos;
    if (!sweepEnds(options, fromPos, toPos))
    {
        return false;
    }
    cancelCapture();
    startSweep(rpm, options, fromPos, toPos);
    return true;
}

// Take photos a step apart, pressing the shutter with the disk still. Returns an error, or nullptr.
const char* sequencerPhoto(float rpm, const PhotoOptions &options, ShutterKey key)
{
    if (options.pressShutter && !shutterStatus().ready)
    {
        return "No phone is connected to the shutter. Pair it, or turn off Press the shutter.";
    }
    beginCapture(Capture::Photo, rpm, key);
    photo = options;
    return nullptr;
}

// Record a video of a spin or sweep: press, lead-in, motion, lead-out, press. Returns an error, or nullptr.
const char* sequencerVideo(float rpm, const VideoOptions &options, const SpinOptions &spin,
    const SweepOptions &sweep, ShutterKey key)
{
    if (!shutterStatus().ready)
    {
        return "No phone is connected to the shutter";
    }
    int32_t fromPos;
    int32_t toPos;
    if (options.motion == JobType::Sweep && !sweepEnds(sweep, fromPos, toPos))
    {
        return "From and To must be different angles";
    }
    beginCapture(Capture::Video, rpm, key);
    video = options;
    videoSpin = spin;
    videoSweep = sweep;
    return nullptr;
}

// Pause a photo capture before its next shot or move. Returns false if none is running.
bool sequencerPause()
{
    if (capture != Capture::Photo)
    {
        return false;
    }
    paused = true;
    return true;
}

// Carry on with a paused capture. Returns false if none is paused.
bool sequencerResume()
{
    if (capture == Capture::None || !paused)
    {
        return false;
    }
    paused = false;
    needsShutter = false;
    // Start the stage's wait over: the disk settles again, and the start delay runs again
    stageStartMs = millis();
    return true;
}

// Rotate by an angle, building on the last target so repeated presses add up exactly
void sequencerMoveBy(double deg, float rpm)
{
    cancelCapture();
    // Build on the last target while that move is unfinished, or the disk still sits on it
    const MotionStatus status = motionStatus();
    const bool onLastTarget = (job == Job::Move && status.state == MotionState::Moving)
        || status.position == moveTargetPos;
    startMove((onLastTarget ? moveTargetDeg : motionHalfStepsToDegrees(status.position)) + deg, rpm);
}

// Go to an angle from zero, the shortest way or a chosen way
void sequencerMoveTo(double deg, MoveDirection dir, float rpm)
{
    cancelCapture();
    const double here = motionHalfStepsToDegrees(motionStatus().position);
    startMove(here + angleDelta(here, deg, dir), rpm);
}

// Change the speed of whatever is running
void sequencerSetSpeed(float rpm)
{
    jobRpm = rpm;
    captureRpm = rpm;
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

// End the job and ramp down. A video that's recording gets a last shutter press to stop it.
void sequencerStop()
{
    cancelCapture();
    job = Job::None;
    motionStop();
}

// End the job, stop now and switch the coils off. A video that's recording gets a last shutter press.
void sequencerHalt()
{
    cancelCapture();
    job = Job::None;
    motionHalt();
}

// Make the current position zero. A running job keeps going to the same places.
void sequencerSetZero()
{
    // Targets are kept from zero, so they shift with it
    const int32_t shift = motionSetZero();
    const double shiftDeg = motionHalfStepsToDegrees(shift);
    targetPos -= shift;
    sweepFromPos -= shift;
    sweepToPos -= shift;
    moveTargetPos -= shift;
    moveTargetDeg -= shiftDeg;
    photoStartDeg -= shiftDeg;
}

// Advance the running job. Called from loop().
void handleSequencer()
{
    stepJob();
    if (capture == Capture::None)
    {
        return;
    }
    // A capture's own move, spin or sweep has finished once the motion layer is done with it
    const bool motionDone = job == Job::None && motionStatus().state == MotionState::Idle;
    const unsigned long elapsed = millis() - stageStartMs;
    if (capture == Capture::Photo)
    {
        stepPhoto(motionDone, elapsed);
    }
    else
    {
        stepVideo(motionDone, elapsed);
    }
}

// What's running, and how much is left
JobStatus sequencerStatus()
{
    JobStatus status = {};
    if (capture == Capture::None)
    {
        status.type = job == Job::Spin ? JobType::Spin : (job == Job::Sweep ? JobType::Sweep : JobType::None);
        addJobProgress(status);
        return status;
    }

    status.type = capture == Capture::Photo ? JobType::Photo : JobType::Video;
    status.stage = captureStage;
    status.paused = paused;
    status.needsShutter = needsShutter;
    if (captureStage == CaptureStage::Delay)
    {
        const uint32_t delayMs = capture == Capture::Photo ? photo.delayMs : video.delayMs;
        const unsigned long elapsed = paused ? 0 : millis() - stageStartMs;
        status.startsIn = elapsed >= delayMs ? 0 : (delayMs - elapsed + 999) / 1000;
    }
    if (capture == Capture::Photo)
    {
        status.shots = photo.shots;
        status.shot = shotIndex < photo.shots ? shotIndex + 1 : photo.shots;
    }
    else
    {
        status.motion = video.motion;
        if (captureStage == CaptureStage::Motion)
        {
            addJobProgress(status);
        }
    }
    return status;
}
