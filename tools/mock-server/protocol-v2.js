// Emulates the firmware's v2 WebSocket protocol (docs/FIRMWARE.md): JSON commands
// with a "cmd" field, and a full "state" broadcast after every command and 10 times
// a second while the disk moves. The motion is simulated with the same ramp logic
// as code/WebTurntable/motion.cpp, so the UI sees realistic angles and speeds.

// Constants copied from config.h.
const HALF_STEPS_PER_REV = 4075.772;
const MIN_RPM = 0.5;
const MAX_RPM_LIMIT = 30;
const DEFAULT_MAX_RPM = 15;
const DEFAULT_RPM = 5;
const MIN_ACCEL = 1;
const MAX_ACCEL = 200;
const DEFAULT_ACCEL = 20;
const START_RPM = 1;

const SETTINGS_SAVE_DELAY_MS = 750;
const TICK_MS = 10;
const STATE_INTERVAL_MS = 100;

const rpmToHalfSteps = (rpm) => (rpm * HALF_STEPS_PER_REV) / 60;
const START_SPEED = rpmToHalfSteps(START_RPM);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Move value toward goal by at most step.
function approach(value, goal, step) {
    return value < goal ? Math.min(value + step, goal) : Math.max(value - step, goal);
}

// Create a v2 device. broadcast(text) sends to every client; log(line) prints.
export function createDevice({ broadcast, log }) {
    const settings = {
        rpm: DEFAULT_RPM,
        dir: 'cw',
        spinning: false,
        driveMode: 'half',
        maxRpm: DEFAULT_MAX_RPM,
        accel: DEFAULT_ACCEL,
    };

    // Simulated motion engine. Position is in half-steps, positive clockwise.
    const motion = { mode: 'idle', velocity: 0, cruise: 0, target: 0, position: 0, zero: 0 };
    // Last move target in degrees, so repeated Rotate by presses don't add up rounding errors.
    let moveTargetDeg = 0;
    let moveTargetPos = 0;
    let saveTimer = null;
    let settingsDirty = false;
    let lastState = 'idle';

    const motionStateName = () => ({ run: 'running', move: 'moving', stop: 'stopping' })[motion.mode] ?? 'idle';
    const relativePosition = () => Math.round(motion.position) - motion.zero;
    const degreesToHalfSteps = (deg) => Math.round((deg * HALF_STEPS_PER_REV) / 360);

    function angle() {
        const deg = ((relativePosition() * 360) / HALF_STEPS_PER_REV) % 360;
        return deg < 0 ? deg + 360 : deg;
    }

    function stateJson() {
        const round = (value, decimals) => Number(value.toFixed(decimals));
        return JSON.stringify({
            type: 'state',
            motion: motionStateName(),
            angle: round(angle(), 1),
            speed: round((motion.velocity * 60) / HALF_STEPS_PER_REV, 2),
            rpm: round(settings.rpm, 2),
            dir: settings.dir,
            spinning: settings.spinning,
            settings: {
                driveMode: settings.driveMode,
                maxRpm: round(settings.maxRpm, 1),
                accel: round(settings.accel, 1),
            },
            limits: { minRpm: MIN_RPM, maxRpm: MAX_RPM_LIMIT, minAccel: MIN_ACCEL, maxAccel: MAX_ACCEL },
        });
    }

    function describe() {
        const { rpm, dir, spinning, driveMode, maxRpm, accel } = settings;
        return `rpm=${rpm.toFixed(2)}, dir=${dir}, spinning=${spinning}, mode=${driveMode}, ` +
            `maxRpm=${maxRpm}, accel=${accel}; ${motionStateName()} at ${angle().toFixed(1)} deg`;
    }

    // The firmware waits for idle before saving, because flash writes pause stepping.
    function queueSettingsSave() {
        settingsDirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(trySave, SETTINGS_SAVE_DELAY_MS);
    }

    function trySave() {
        if (!settingsDirty) {
            return;
        }
        if (motion.mode !== 'idle') {
            saveTimer = setTimeout(trySave, STATE_INTERVAL_MS);
            return;
        }
        settingsDirty = false;
        log(`Settings saved: ${describe()}`);
    }

    function motionRun(rpm, dir) {
        const speed = rpmToHalfSteps(rpm);
        Object.assign(motion, { mode: 'run', cruise: dir === 'cw' ? speed : -speed });
    }

    function motionMoveTo(position, rpm) {
        Object.assign(motion, { mode: 'move', cruise: rpmToHalfSteps(rpm), target: motion.zero + position });
    }

    function motionStop() {
        if (motion.mode !== 'idle') {
            motion.mode = 'stop';
        }
    }

    function motionHalt() {
        Object.assign(motion, { mode: 'idle', velocity: 0 });
        motion.position = Math.round(motion.position);
    }

    // One control tick, the same logic as controlTask() in motion.cpp.
    function tick(dt) {
        const accel = rpmToHalfSteps(settings.accel);
        const dv = accel * dt;
        const remaining = motion.target - motion.position;

        switch (motion.mode) {
            case 'run':
                motion.velocity = approach(motion.velocity, motion.cruise, dv);
                break;
            case 'stop':
                motion.velocity = approach(motion.velocity, 0, dv);
                if (Math.abs(motion.velocity) <= START_SPEED) {
                    motion.mode = 'idle';
                }
                break;
            case 'move': {
                const sign = Math.sign(Math.round(remaining));
                if (Math.abs(remaining) < 0.5 && Math.abs(motion.velocity) <= START_SPEED) {
                    motion.mode = 'idle';
                } else if (sign === 0 || motion.velocity * sign < 0) {
                    motion.velocity = approach(motion.velocity, 0, dv);
                } else if (Math.abs(remaining) <= (motion.velocity ** 2) / (2 * accel) + 1) {
                    motion.velocity = approach(motion.velocity, sign * START_SPEED, dv);
                } else {
                    motion.velocity = approach(motion.velocity, sign * motion.cruise, dv);
                }
                break;
            }
        }

        if (motion.mode === 'idle') {
            motion.velocity = 0;
            motion.position = Math.round(motion.position);
            return;
        }

        // Integrate position at no less than the start speed, and stop exactly on a move's target.
        const floor = motion.mode === 'run' ? Math.min(START_SPEED, Math.abs(motion.cruise)) : START_SPEED;
        const heading = motion.velocity || (motion.mode === 'run' ? motion.cruise : remaining);
        const speed = Math.max(Math.abs(motion.velocity), floor);
        let step = Math.sign(heading) * speed * dt;
        if (motion.mode === 'move' && Math.sign(step) === Math.sign(remaining) && Math.abs(step) > Math.abs(remaining)) {
            step = remaining;
        }
        motion.position += step;
    }

    // Validate a message the way parseCommand() in server.cpp does.
    function parseCommand(msg) {
        const { cmd } = msg ?? {};
        switch (cmd) {
            case 'speed':
                return isNumber(msg.rpm) ? { cmd, rpm: msg.rpm } : { error: 'speed needs a number rpm' };
            case 'run':
                if (msg.dir !== 'cw' && msg.dir !== 'ccw') {
                    return { error: 'run needs dir cw or ccw' };
                }
                return { cmd, dir: msg.dir, rpm: isNumber(msg.rpm) ? msg.rpm : undefined };
            case 'stop':
            case 'halt':
            case 'setZero':
                return { cmd };
            case 'moveBy':
            case 'moveTo': {
                if (!isNumber(msg.deg)) {
                    return { error: 'move needs a number deg' };
                }
                const dir = msg.dir ?? 'shortest';
                if (!['shortest', 'cw', 'ccw'].includes(dir)) {
                    return { error: 'dir must be shortest, cw or ccw' };
                }
                return { cmd, deg: msg.deg, dir };
            }
            case 'settings':
                if (msg.driveMode !== undefined && msg.driveMode !== 'half' && msg.driveMode !== 'full') {
                    return { error: 'driveMode must be half or full' };
                }
                return {
                    cmd,
                    driveMode: msg.driveMode,
                    maxRpm: isNumber(msg.maxRpm) ? msg.maxRpm : undefined,
                    accel: isNumber(msg.accel) ? msg.accel : undefined,
                };
            default:
                return { error: 'unknown command' };
        }
    }

    function stopSpinning() {
        if (settings.spinning) {
            settings.spinning = false;
            queueSettingsSave();
        }
    }

    // Run one command, the same way executeCommand() in server.cpp does.
    function execute(command) {
        const state = motionStateName();
        switch (command.cmd) {
            case 'speed':
                settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                if (settings.spinning) {
                    motionRun(settings.rpm, settings.dir);
                }
                queueSettingsSave();
                break;
            case 'run':
                if (command.rpm !== undefined) {
                    settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                }
                settings.dir = command.dir;
                settings.spinning = true;
                if (state === 'idle') {
                    settingsDirty = true;
                    trySave();
                } else {
                    queueSettingsSave();
                }
                motionRun(settings.rpm, settings.dir);
                break;
            case 'stop':
                stopSpinning();
                motionStop();
                break;
            case 'halt':
                stopSpinning();
                motionHalt();
                break;
            case 'moveBy':
            case 'moveTo': {
                const onLastTarget = state === 'moving' || relativePosition() === moveTargetPos;
                const here = (relativePosition() * 360) / HALF_STEPS_PER_REV;
                let targetDeg;
                if (command.cmd === 'moveBy') {
                    targetDeg = (onLastTarget ? moveTargetDeg : here) + command.deg;
                } else {
                    let delta = (command.deg - angle()) % 360;
                    if (delta < 0) {
                        delta += 360;
                    }
                    if (command.dir === 'shortest' && delta > 180) {
                        delta -= 360;
                    } else if (command.dir === 'ccw' && delta > 0) {
                        delta -= 360;
                    }
                    targetDeg = here + delta;
                }
                stopSpinning();
                moveTargetDeg = targetDeg;
                moveTargetPos = degreesToHalfSteps(targetDeg);
                motionMoveTo(moveTargetPos, settings.rpm);
                break;
            }
            case 'setZero':
                motion.zero = Math.round(motion.position);
                moveTargetDeg = 0;
                moveTargetPos = 0;
                break;
            case 'settings':
                if (command.driveMode !== undefined) {
                    settings.driveMode = command.driveMode;
                }
                if (command.maxRpm !== undefined) {
                    settings.maxRpm = clamp(command.maxRpm, MIN_RPM, MAX_RPM_LIMIT);
                    if (settings.rpm > settings.maxRpm) {
                        settings.rpm = settings.maxRpm;
                        if (settings.spinning) {
                            motionRun(settings.rpm, settings.dir);
                        }
                    }
                }
                if (command.accel !== undefined) {
                    settings.accel = clamp(command.accel, MIN_ACCEL, MAX_ACCEL);
                }
                queueSettingsSave();
                break;
        }
    }

    function onMessage(client, text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            client.send(JSON.stringify({ type: 'error', msg: 'malformed JSON' }));
            return;
        }
        const command = parseCommand(msg);
        if (command.error) {
            log(`[${client.remoteAddress}] rejected ${text.slice(0, 80)}: ${command.error}`);
            client.send(JSON.stringify({ type: 'error', msg: command.error }));
            return;
        }
        execute(command);
        log(`[${client.remoteAddress}] ${text.slice(0, 80)} -> ${describe()}`);
        broadcast(stateJson());
    }

    // Simulate the control task, and broadcast like handleStateBroadcast().
    let sinceBroadcast = 0;
    const timer = setInterval(() => {
        tick(TICK_MS / 1000);
        sinceBroadcast += TICK_MS;
        if (sinceBroadcast >= STATE_INTERVAL_MS) {
            sinceBroadcast = 0;
            const state = motionStateName();
            if (state !== 'idle' || state !== lastState) {
                broadcast(stateJson());
            }
            lastState = state;
        }
    }, TICK_MS);
    timer.unref();

    return {
        onConnect(client) {
            log(`Client connected [${client.remoteAddress}]`);
            client.send(stateJson());
        },
        onMessage,
        onDisconnect(client) {
            log(`Client disconnected [${client.remoteAddress}]`);
        },
        describe,
        close() {
            clearInterval(timer);
            clearTimeout(saveTimer);
        },
    };
}
