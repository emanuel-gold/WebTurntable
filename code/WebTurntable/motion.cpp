#include "motion.h"
#include "config.h"

#include <cmath>

#include <driver/gptimer.h>
#include <esp_timer.h>
#include <soc/gpio_struct.h>

namespace
{
    // Coil pattern (IN1-IN4) for each of the 8 half-step phases. Odd entries energize two coils.
    constexpr uint8_t PHASE_PATTERN[8][4] =
    {
        {1, 0, 0, 0},
        {1, 1, 0, 0},
        {0, 1, 0, 0},
        {0, 1, 1, 0},
        {0, 0, 1, 0},
        {0, 0, 1, 1},
        {0, 0, 0, 1},
        {1, 0, 0, 1}
    };

    constexpr uint32_t IDLE_INTERVAL_US = 1000;     // Timer tick while not stepping
    constexpr uint32_t MIN_ALARM_LEAD_US = 20;      // Never schedule an alarm closer than this
    constexpr float START_SPEED = START_RPM * HALF_STEPS_PER_REV / 60.0f;

    // GPIO register masks per phase, built in motionBegin() so the ISR only writes registers.
    // Bank 0 holds GPIO 0-31, bank 1 holds GPIO 32-39.
    DRAM_ATTR uint32_t s_setMask0[8];
    DRAM_ATTR uint32_t s_clearMask0[8];
    DRAM_ATTR uint32_t s_setMask1[8];
    DRAM_ATTR uint32_t s_clearMask1[8];
    DRAM_ATTR uint32_t s_allMask0 = 0;
    DRAM_ATTR uint32_t s_allMask1 = 0;

    // Shared with the step ISR, which runs on core 1 like the control task.
    // The ISR alone writes s_position and s_phase; the control task writes the rest.
    volatile int32_t s_position = 0;            // Half-steps, positive clockwise
    volatile uint8_t s_phase = 0;               // Index into PHASE_PATTERN
    volatile int8_t s_stepDir = 0;              // +1 clockwise, -1 counter-clockwise, 0 not stepping
    volatile uint32_t s_intervalUs = IDLE_INTERVAL_US;
    volatile uint8_t s_stride = 1;              // Half-steps per step event: 1 half-step, 2 full-step
    volatile int32_t s_target = 0;
    volatile bool s_hasTarget = false;
    volatile bool s_release = false;            // Switch the coils off on the next tick

    // Control modes of the ramp task
    enum class Mode : uint8_t
    {
        Idle,
        Run,
        Move,
        Stop
    };

    // A request from the API, picked up by the control task on its next tick
    struct Request
    {
        bool pending;
        Mode mode;
        float cruise;       // Half-steps/s: signed for Run, a magnitude for Move
        int32_t target;     // Raw position for Move
    };

    // Everything below is guarded by s_mux
    portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
    Request s_request = {};
    float s_accel = DEFAULT_ACCEL * HALF_STEPS_PER_REV / 60.0f;    // Half-steps/s^2
    DriveMode s_driveMode = DriveMode::Half;
    Mode s_publishedMode = Mode::Idle;
    float s_publishedVelocity = 0.0f;

    // Only touched from the API caller (loop)
    int32_t s_zero = 0;
    gptimer_handle_t s_timer = nullptr;

    // Convert RPM to half-steps per second
    float rpmToHalfSteps(float rpm)
    {
        return rpm * HALF_STEPS_PER_REV / 60.0f;
    }

    // Move value toward goal by at most step
    float approach(float value, float goal, float step)
    {
        if (value < goal)
        {
            return fminf(value + step, goal);
        }
        return fmaxf(value - step, goal);
    }

    // Write one phase's coil pattern straight to the GPIO registers
    inline void IRAM_ATTR writePhase(uint8_t phase)
    {
        GPIO.out_w1tc = s_clearMask0[phase];
        GPIO.out_w1ts = s_setMask0[phase];
        GPIO.out1_w1tc.val = s_clearMask1[phase];
        GPIO.out1_w1ts.val = s_setMask1[phase];
    }

    // Step timer callback: make one step event, then schedule the next alarm
    bool IRAM_ATTR onStepTimer(gptimer_handle_t timer, const gptimer_alarm_event_data_t *edata, void *)
    {
        const int8_t dir = s_stepDir;
        if (dir != 0)
        {
            int32_t step = s_stride;
            uint8_t phase = s_phase;

            // Full-step mode takes a half-step first if needed to land on a two-coil phase
            if (step == 2 && (phase & 1) == 0)
            {
                step = 1;
            }

            // Never step past the target of a move
            if (s_hasTarget)
            {
                const int32_t ahead = (s_target - s_position) * dir;
                if (ahead >= 0 && ahead < step)
                {
                    step = ahead;
                }
            }

            if (step > 0)
            {
                // Clockwise walks the table backwards, as in v1
                phase = (phase + (dir > 0 ? 8 - step : step)) & 7;
                s_phase = phase;
                writePhase(phase);
                s_position = s_position + dir * step;
            }

            if (s_hasTarget && s_position == s_target)
            {
                s_stepDir = 0;
            }
        }
        else if (s_release)
        {
            GPIO.out_w1tc = s_allMask0;
            GPIO.out1_w1tc.val = s_allMask1;
            s_release = false;
        }

        // Schedule from the previous alarm for even timing, but never in the past
        uint64_t next = edata->alarm_value + (dir != 0 ? s_intervalUs : IDLE_INTERVAL_US);
        if (next < edata->count_value + MIN_ALARM_LEAD_US)
        {
            next = edata->count_value + MIN_ALARM_LEAD_US;
        }
        gptimer_alarm_config_t alarm = {};
        alarm.alarm_count = next;
        gptimer_set_alarm_action(timer, &alarm);
        return false;
    }

    // Queue a request for the control task
    void request(Mode mode, float cruise, int32_t target)
    {
        portENTER_CRITICAL(&s_mux);
        s_request.pending = true;
        s_request.mode = mode;
        s_request.cruise = cruise;
        s_request.target = target;
        portEXIT_CRITICAL(&s_mux);
    }

    // 1 kHz ramp loop: works out the velocity and hands the step interval to the ISR
    void controlTask(void *)
    {
        Mode mode = Mode::Idle;
        float velocity = 0.0f;      // Half-steps/s, positive clockwise
        float cruise = 0.0f;
        int32_t target = 0;
        int64_t lastUs = esp_timer_get_time();
        TickType_t lastWake = xTaskGetTickCount();

        for (;;)
        {
            vTaskDelayUntil(&lastWake, 1);
            const int64_t nowUs = esp_timer_get_time();
            const float dt = fminf((nowUs - lastUs) * 1e-6f, 0.02f);
            lastUs = nowUs;

            float accel;
            uint8_t stride;
            portENTER_CRITICAL(&s_mux);
            if (s_request.pending)
            {
                mode = s_request.mode;
                cruise = s_request.cruise;
                target = s_request.target;
                s_request.pending = false;
            }
            accel = s_accel;
            stride = s_driveMode == DriveMode::Full ? 2 : 1;
            portEXIT_CRITICAL(&s_mux);

            const float dv = accel * dt;
            const int32_t remaining = target - s_position;
            float heading = 0.0f;   // Direction to use when the velocity is zero

            switch (mode)
            {
                case Mode::Run:
                    velocity = approach(velocity, cruise, dv);
                    heading = cruise;
                    break;

                case Mode::Stop:
                    velocity = approach(velocity, 0.0f, dv);
                    if (fabsf(velocity) <= START_SPEED)
                    {
                        mode = Mode::Idle;
                    }
                    break;

                case Mode::Move:
                {
                    const float sign = remaining > 0 ? 1.0f : (remaining < 0 ? -1.0f : 0.0f);
                    heading = sign;
                    if (remaining == 0 && fabsf(velocity) <= START_SPEED)
                    {
                        mode = Mode::Idle;
                    }
                    else if (sign == 0.0f || velocity * sign < 0.0f)
                    {
                        // At the target, or heading away from it: slow down first
                        velocity = approach(velocity, 0.0f, dv);
                    }
                    else if (fabsf((float)remaining) <= velocity * velocity / (2.0f * accel) + 1.0f)
                    {
                        // Inside the braking distance: decelerate to the start speed
                        velocity = approach(velocity, sign * START_SPEED, dv);
                    }
                    else
                    {
                        velocity = approach(velocity, sign * cruise, dv);
                    }
                    break;
                }

                case Mode::Idle:
                    break;
            }

            if (mode == Mode::Idle)
            {
                if (velocity != 0.0f || s_stepDir != 0)
                {
                    s_stepDir = 0;
                    s_release = true;
                }
                velocity = 0.0f;
            }
            else
            {
                // Below the start speed the motor can step without a ramp
                float floorSpeed = START_SPEED;
                if (mode == Mode::Run)
                {
                    floorSpeed = fminf(START_SPEED, fabsf(cruise));
                }
                const float speed = fmaxf(fabsf(velocity), floorSpeed);
                const float dirValue = velocity != 0.0f ? velocity : heading;

                // Order matters: the ISR can run between these writes
                s_target = target;
                s_hasTarget = mode == Mode::Move;
                s_stride = stride;
                s_intervalUs = (uint32_t)(stride * 1e6f / speed);
                s_stepDir = dirValue > 0.0f ? 1 : (dirValue < 0.0f ? -1 : 0);
            }

            portENTER_CRITICAL(&s_mux);
            s_publishedMode = mode;
            s_publishedVelocity = velocity;
            portEXIT_CRITICAL(&s_mux);
        }
    }
}

// Set up the coil pins, the step timer and the control task
void motionBegin()
{
    for (uint8_t i = 0; i < 4; i++)
    {
        pinMode(MOTOR_PINS[i], OUTPUT);
        digitalWrite(MOTOR_PINS[i], LOW);
        const uint32_t bit = 1UL << (MOTOR_PINS[i] & 31);
        if (MOTOR_PINS[i] < 32)
        {
            s_allMask0 |= bit;
        }
        else
        {
            s_allMask1 |= bit;
        }
    }

    for (uint8_t phase = 0; phase < 8; phase++)
    {
        s_setMask0[phase] = s_clearMask0[phase] = s_setMask1[phase] = s_clearMask1[phase] = 0;
        for (uint8_t i = 0; i < 4; i++)
        {
            const uint32_t bit = 1UL << (MOTOR_PINS[i] & 31);
            const bool on = PHASE_PATTERN[phase][i];
            if (MOTOR_PINS[i] < 32)
            {
                (on ? s_setMask0 : s_clearMask0)[phase] |= bit;
            }
            else
            {
                (on ? s_setMask1 : s_clearMask1)[phase] |= bit;
            }
        }
    }

    // The control task and the timer interrupt both live on core 1, away from Wi-Fi on core 0
    xTaskCreatePinnedToCore(controlTask, "motion", 4096, nullptr, 5, nullptr, 1);

    gptimer_config_t timerConfig = {};
    timerConfig.clk_src = GPTIMER_CLK_SRC_DEFAULT;
    timerConfig.direction = GPTIMER_COUNT_UP;
    timerConfig.resolution_hz = 1000000;
    gptimer_alarm_config_t alarm = {};
    alarm.alarm_count = IDLE_INTERVAL_US;
    gptimer_event_callbacks_t callbacks = {};
    callbacks.on_alarm = onStepTimer;

    if (gptimer_new_timer(&timerConfig, &s_timer) != ESP_OK
        || gptimer_register_event_callbacks(s_timer, &callbacks, nullptr) != ESP_OK
        || gptimer_set_alarm_action(s_timer, &alarm) != ESP_OK
        || gptimer_enable(s_timer) != ESP_OK
        || gptimer_start(s_timer) != ESP_OK)
    {
        Serial.println("Error: Failed to start the step timer");
    }
}

// Spin continuously, ramping to the given speed and direction
void motionRun(float rpm, Direction dir)
{
    const float speed = rpmToHalfSteps(rpm);
    request(Mode::Run, dir == Direction::CW ? speed : -speed, 0);
}

// Go to an absolute position in half-steps from the session zero, at up to the given speed
void motionMoveTo(int32_t position, float rpm)
{
    request(Mode::Move, rpmToHalfSteps(rpm), s_zero + position);
}

// Ramp down to a stop
void motionStop()
{
    if (motionStatus().state != MotionState::Idle)
    {
        request(Mode::Stop, 0.0f, 0);
    }
}

// Stop immediately and switch the coils off
void motionHalt()
{
    request(Mode::Idle, 0.0f, 0);
    s_stepDir = 0;
    s_release = true;
}

// Make the current position the zero angle. Returns how far zero moved, in half-steps.
int32_t motionSetZero()
{
    // Read the position once, since the step ISR may move it
    const int32_t position = s_position;
    const int32_t shift = position - s_zero;
    s_zero = position;
    return shift;
}

// Change the drive mode; takes effect on the next step
void motionSetDriveMode(DriveMode mode)
{
    portENTER_CRITICAL(&s_mux);
    s_driveMode = mode;
    portEXIT_CRITICAL(&s_mux);
}

// Change the acceleration used by all ramps
void motionSetAcceleration(float rpmPerSecond)
{
    portENTER_CRITICAL(&s_mux);
    s_accel = rpmToHalfSteps(rpmPerSecond);
    portEXIT_CRITICAL(&s_mux);
}

// Current position, angle, speed and state
MotionStatus motionStatus()
{
    portENTER_CRITICAL(&s_mux);
    const Mode mode = s_request.pending ? s_request.mode : s_publishedMode;
    const float velocity = s_publishedVelocity;
    portEXIT_CRITICAL(&s_mux);

    MotionStatus status;
    status.position = s_position - s_zero;
    // Double precision, so the angle stays exact after many revolutions
    double angle = fmod(status.position * 360.0 / HALF_STEPS_PER_REV, 360.0);
    if (angle < 0.0)
    {
        angle += 360.0;
    }
    status.angleDeg = (float)angle;
    status.speedRpm = velocity * 60.0f / HALF_STEPS_PER_REV;

    switch (mode)
    {
        case Mode::Run:
            status.state = MotionState::Running;
            break;
        case Mode::Move:
            status.state = MotionState::Moving;
            break;
        case Mode::Stop:
            status.state = MotionState::Stopping;
            break;
        default:
            status.state = MotionState::Idle;
            break;
    }
    return status;
}

// Half-steps for an angle in degrees (positive clockwise)
int32_t motionDegreesToHalfSteps(double degrees)
{
    return (int32_t)lround(degrees * HALF_STEPS_PER_REV / 360.0);
}

// Degrees for a position in half-steps, without wrapping
double motionHalfStepsToDegrees(int32_t halfSteps)
{
    return halfSteps * 360.0 / HALF_STEPS_PER_REV;
}
