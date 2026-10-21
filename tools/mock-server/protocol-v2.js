// Emulates the firmware's v2 WebSocket protocol (docs/FIRMWARE.md): JSON commands
// with a "cmd" field, and a full "state" broadcast after every command and 10 times
// a second while the disk moves. The motion is simulated with the same ramp logic
// as code/WebTurntable/motion.cpp, so the UI sees realistic angles and speeds.
// Jobs (spins with a stop condition, sweeps) follow sequencer.cpp, and presets
// follow presets.cpp, kept in memory for as long as the mock runs.

// Wi-Fi setup (wireless.cpp) is emulated too: /api/wifi/* for the setup page, the "wifi"
// field in the state, and the wifiSetup command. Joining with the password
// "wrongpassword" fails, so the error path can be tried.

// Constants copied from config.h.
const HALF_STEPS_PER_REV = 4096;
const MIN_RPM = 0.5;
const MAX_RPM_LIMIT = 20;
const DEFAULT_MAX_RPM = 20;
const DEFAULT_RPM = 5;
const MIN_ACCEL = 1;
const MAX_ACCEL = 200;
const DEFAULT_ACCEL = 20;
const START_RPM = 1;
const MIN_STOP_REVS = 0.1;
const MAX_STOP_REVS = 1000;
const MIN_STOP_MINUTES = 0.1;
const MAX_STOP_MINUTES = 600;
const MAX_SWEEP_CYCLES = 1000;
const MAX_SWEEP_DEG = 3600;
const MAX_DWELL_MS = 60000;

// From presets.h: 10 slots, and names up to 63 bytes of UTF-8.
const PRESET_SLOTS = 10;
const PRESET_NAME_BYTES = 63;

const SETTINGS_SAVE_DELAY_MS = 750;
const TICK_MS = 10;
const STATE_INTERVAL_MS = 100;

// Wi-Fi timings, shortened from wireless.cpp so the flow is quick to try.
const JOIN_DELAY_MS = 2000;
const JOINED_GRACE_MS = 5000;
const SCAN_DELAY_MS = 1500;
const LAN = { ssid: 'Home Wi-Fi', ip: '192.168.1.42', rssi: -58 };
const FAKE_NETWORKS = [
    { ssid: 'Home Wi-Fi', rssi: -52, secure: true },
    { ssid: 'Cafe Guest', rssi: -70, secure: false },
    { ssid: 'Neighbour 2.4G', rssi: -81, secure: true },
];

const rpmToHalfSteps = (rpm) => (rpm * HALF_STEPS_PER_REV) / 60;
const START_SPEED = rpmToHalfSteps(START_RPM);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const clampFinite = (value, low, high, fallback) => (Number.isFinite(value) ? clamp(value, low, high) : fallback);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isAbsent = (value) => value === undefined || value === null;
const round = (value, decimals) => Number(value.toFixed(decimals));
const degreesToHalfSteps = (deg) => Math.round((deg * HALF_STEPS_PER_REV) / 360);
const halfStepsToDegrees = (halfSteps) => (halfSteps * 360) / HALF_STEPS_PER_REV;

// Move value toward goal by at most step.
function approach(value, goal, step) {
    return value < goal ? Math.min(value + step, goal) : Math.max(value - step, goal);
}

// Degrees to turn from one angle to another: the shortest way, or round cw or ccw.
function angleDelta(fromDeg, toDeg, dir) {
    let delta = (toDeg - fromDeg) % 360;
    if (delta < 0) {
        delta += 360;
    }
    if (dir === 'shortest' && delta > 180) {
        delta -= 360;
    } else if (dir === 'ccw' && delta > 0) {
        delta -= 360;
    }
    return delta;
}

// Keep spin options inside the limits, like clampSpinOptions() in sequencer.cpp.
function clampSpinOptions(options) {
    if (options.stopAfter === 'minutes') {
        options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_STOP_MINUTES, 1);
        return;
    }
    // "never" keeps the value for when a limit is picked
    if (options.stopAfter !== 'revs') {
        options.stopAfter = 'never';
    }
    options.stopValue = clampFinite(options.stopValue, MIN_STOP_REVS, MAX_STOP_REVS, 1);
}

// Keep sweep options inside the limits, like clampSweepOptions() in sequencer.cpp.
function clampSweepOptions(options) {
    options.fromDeg = clampFinite(options.fromDeg, -MAX_SWEEP_DEG, MAX_SWEEP_DEG, -30);
    options.toDeg = clampFinite(options.toDeg, -MAX_SWEEP_DEG, MAX_SWEEP_DEG, 30);
    options.dwellMs = Math.min(options.dwellMs, MAX_DWELL_MS);
    if (options.stopAfter === 'cycles') {
        options.stopValue = Math.round(clampFinite(options.stopValue, 1, MAX_SWEEP_CYCLES, 4));
    } else if (options.stopAfter === 'minutes') {
        options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_STOP_MINUTES, 1);
    } else {
        options.stopAfter = 'never';
        options.stopValue = clampFinite(options.stopValue, MIN_STOP_MINUTES, MAX_SWEEP_CYCLES, 4);
    }
}

const spinJson = (options) => ({ stopAfter: options.stopAfter, stopValue: round(options.stopValue, 2) });
const sweepJson = (options) => ({
    fromDeg: round(options.fromDeg, 1),
    toDeg: round(options.toDeg, 1),
    dwellMs: options.dwellMs,
    stopAfter: options.stopAfter,
    stopValue: round(options.stopValue, 2),
});

// Read the optional stopAfter and stopValue fields, like parseStopFields() in server.cpp.
function parseStopFields(msg, countName) {
    const fields = {};
    if (!isAbsent(msg.stopAfter)) {
        if (!['never', countName, 'minutes'].includes(msg.stopAfter)) {
            return { error: `stopAfter must be never, ${countName} or minutes` };
        }
        fields.stopAfter = msg.stopAfter;
    }
    if (!isAbsent(msg.stopValue)) {
        if (!isNumber(msg.stopValue)) {
            return { error: 'stopValue must be a number' };
        }
        fields.stopValue = msg.stopValue;
    }
    return { fields };
}

// Read the optional sweep option fields, like parseSweepFields() in server.cpp.
function parseSweepFields(msg) {
    const fields = {};
    for (const key of ['fromDeg', 'toDeg', 'dwellMs']) {
        if (!isAbsent(msg[key])) {
            if (!isNumber(msg[key])) {
                return { error: 'fromDeg, toDeg and dwellMs must be numbers' };
            }
            fields[key] = msg[key];
        }
    }
    if (fields.dwellMs !== undefined) {
        fields.dwellMs = fields.dwellMs <= 0 ? 0 : Math.min(Math.round(fields.dwellMs), MAX_DWELL_MS);
    }
    const stop = parseStopFields(msg, 'cycles');
    return stop.error ? stop : { fields: { ...fields, ...stop.fields } };
}

// Create a v2 device. broadcast(text) sends to every client; log(line) prints.
export function createDevice({ broadcast, log, wifi: initialWifi = 'lan', restart = () => {} }) {
    const settings = {
        rpm: DEFAULT_RPM,
        dir: 'cw',
        driveMode: 'half',
        maxRpm: DEFAULT_MAX_RPM,
        accel: DEFAULT_ACCEL,
        spin: { stopAfter: 'never', stopValue: 1 },
        sweep: { fromDeg: -30, toDeg: 30, dwellMs: 500, stopAfter: 'never', stopValue: 4 },
    };

    // Simulated motion engine. Position is in half-steps, positive clockwise.
    const motion = { mode: 'idle', velocity: 0, cruise: 0, target: 0, position: 0, zero: 0 };

    // Emulated sequencer.cpp. job is none, move, spin or sweep; stopAfter is never, count or minutes.
    const seq = {
        job: 'none',
        rpm: DEFAULT_RPM,
        stopAfter: 'never',
        startMs: 0,
        limitMs: 0,
        targetPos: 0,
        spinDir: 'cw',
        // Last move target in degrees, so repeated Rotate by presses don't add up rounding errors.
        moveTargetDeg: 0,
        moveTargetPos: 0,
        fromPos: 0,
        toPos: 0,
        dwellMs: 0,
        cycleLimit: 0,
        cyclesDone: 0,
        approaching: false,
        stage: 'travel',
        dwellStartMs: 0,
    };

    // Emulated presets.cpp: one entry per slot, or null.
    const presets = Array(PRESET_SLOTS).fill(null);

    let saveTimer = null;
    let settingsDirty = false;
    let lastState = 'idle';
    let lastJob = 'none';

    // Emulated wireless.cpp state.
    const wifi = initialWifi === 'setup'
        ? { mode: 'setup', ssid: '', ip: '', rssi: 0, error: '' }
        : { mode: 'lan', ...LAN, error: '' };
    let scanReadyAt = 0;
    let wifiTimer = null;

    const motionStateName = () => ({ run: 'running', move: 'moving', stop: 'stopping' })[motion.mode] ?? 'idle';
    const relativePosition = () => Math.round(motion.position) - motion.zero;
    const jobType = () => (seq.job === 'spin' || seq.job === 'sweep' ? seq.job : 'none');

    function angle() {
        const deg = ((relativePosition() * 360) / HALF_STEPS_PER_REV) % 360;
        return deg < 0 ? deg + 360 : deg;
    }

    // The running spin or sweep and what's left of it, like stateJson() in server.cpp.
    function jobJson() {
        if (jobType() === 'none') {
            return null;
        }
        const job = { type: seq.job };
        if (seq.job === 'spin' && seq.stopAfter === 'count') {
            job.revsLeft = round(Math.abs(seq.targetPos - relativePosition()) / HALF_STEPS_PER_REV, 2);
        }
        if (seq.job === 'sweep') {
            job.cycle = seq.cyclesDone + 1;
            if (seq.stopAfter === 'count') {
                job.cycles = seq.cycleLimit;
            }
        }
        if (seq.stopAfter === 'minutes') {
            const elapsed = Date.now() - seq.startMs;
            job.secondsLeft = elapsed >= seq.limitMs ? 0 : Math.ceil((seq.limitMs - elapsed) / 1000);
        }
        return job;
    }

    function stateJson() {
        return JSON.stringify({
            type: 'state',
            motion: motionStateName(),
            angle: round(angle(), 1),
            speed: round((motion.velocity * 60) / HALF_STEPS_PER_REV, 2),
            rpm: round(settings.rpm, 2),
            dir: settings.dir,
            spinning: seq.job === 'spin',
            job: jobJson(),
            spin: spinJson(settings.spin),
            sweep: sweepJson(settings.sweep),
            settings: {
                driveMode: settings.driveMode,
                maxRpm: round(settings.maxRpm, 1),
                accel: round(settings.accel, 1),
            },
            wifi: { mode: wifi.mode, ssid: wifi.ssid, ip: wifi.ip, rssi: wifi.rssi },
            limits: {
                minRpm: MIN_RPM,
                maxRpm: MAX_RPM_LIMIT,
                minAccel: MIN_ACCEL,
                maxAccel: MAX_ACCEL,
                minRevs: MIN_STOP_REVS,
                maxRevs: MAX_STOP_REVS,
                minMinutes: MIN_STOP_MINUTES,
                maxMinutes: MAX_STOP_MINUTES,
                maxCycles: MAX_SWEEP_CYCLES,
                maxSweepDeg: MAX_SWEEP_DEG,
                maxDwellMs: MAX_DWELL_MS,
            },
        });
    }

    function presetsJson() {
        const list = presets.flatMap((preset, id) => (preset === null ? [] : [{
            id,
            name: preset.name,
            mode: preset.mode,
            rpm: round(preset.rpm, 2),
            ...(preset.mode === 'sweep' ? sweepJson(preset.sweep) : spinJson(preset.spin)),
        }]));
        return JSON.stringify({ type: 'presets', presets: list });
    }

    function setWifi(fields) {
        Object.assign(wifi, { ssid: '', ip: '', rssi: 0, error: '' }, fields);
        log(`Wi-Fi: ${wifi.mode}${wifi.ssid ? ` (${wifi.ssid})` : ''}${wifi.error ? `: ${wifi.error}` : ''}`);
    }

    const sendJson = (res, code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return code;
    };

    const readForm = (req) => new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => resolve(new URLSearchParams(body)));
    });

    // The routes wireless.cpp adds. Returns the HTTP status, or null to fall through to files.
    async function handleHttp(req, res) {
        const { pathname } = new URL(req.url, 'http://mock');
        const inSetup = ['setup', 'joining', 'joined'].includes(wifi.mode);

        if (pathname === '/' && req.method === 'GET' && inSetup) {
            res.writeHead(302, { Location: '/setup' });
            res.end();
            return 302;
        }
        if (pathname === '/setup' && req.method === 'GET') {
            req.url = '/setup.html';
            return null;
        }
        if (pathname === '/api/wifi/status' && req.method === 'GET') {
            return sendJson(res, 200, {
                mode: wifi.mode, ssid: wifi.ssid, ip: wifi.ip, rssi: wifi.rssi, error: wifi.error,
                hostname: 'turntable.local',
            });
        }
        if (pathname === '/api/wifi/scan' && req.method === 'GET') {
            const now = Date.now();
            if (scanReadyAt === 0) {
                scanReadyAt = now + SCAN_DELAY_MS;
            }
            const scanning = now < scanReadyAt;
            return sendJson(res, 200, { scanning, networks: scanning ? [] : FAKE_NETWORKS });
        }
        if (pathname === '/api/wifi/join' && req.method === 'POST') {
            const form = await readForm(req);
            const ssid = form.get('ssid') ?? '';
            const password = form.get('password') ?? '';
            if (ssid.length === 0 || ssid.length > 32) {
                return sendJson(res, 400, { error: 'Enter a network name (up to 32 characters).' });
            }
            if (password.length > 0 && (password.length < 8 || password.length > 63)) {
                return sendJson(res, 400, { error: 'Wi-Fi passwords are 8 to 63 characters.' });
            }
            if (wifi.mode === 'setup') {
                setWifi({ mode: 'joining', ssid });
                clearTimeout(wifiTimer);
                wifiTimer = setTimeout(() => {
                    if (password === 'wrongpassword') {
                        setWifi({ mode: 'setup', error: "Couldn't join: check the password." });
                        return;
                    }
                    setWifi({ mode: 'joined', ssid, ip: LAN.ip, rssi: LAN.rssi });
                    wifiTimer = setTimeout(() => setWifi({ mode: 'lan', ssid, ip: LAN.ip, rssi: LAN.rssi }), JOINED_GRACE_MS);
                }, JOIN_DELAY_MS);
            }
            return sendJson(res, 202, { ok: true });
        }
        if (pathname === '/api/wifi/ap' && req.method === 'POST') {
            if (wifi.mode === 'setup') {
                setWifi({ mode: 'ap' });
            }
            return sendJson(res, 202, { ok: true });
        }
        return null;
    }

    function describe() {
        const { rpm, dir, driveMode, maxRpm, accel, spin, sweep } = settings;
        return `rpm=${rpm.toFixed(2)}, dir=${dir}, mode=${driveMode}, maxRpm=${maxRpm}, accel=${accel}, ` +
            `spin=${spin.stopAfter} ${spin.stopValue}, sweep=${sweep.fromDeg}..${sweep.toDeg} dwell ${sweep.dwellMs} ` +
            `${sweep.stopAfter} ${sweep.stopValue}; ${jobType() === 'none' ? '' : `${seq.job} job, `}` +
            `${motionStateName()} at ${angle().toFixed(1)} deg`;
    }

    // The firmware waits while the disk moves to a target, because flash writes pause stepping.
    // Spins are saved as they run.
    function queueSettingsSave() {
        settingsDirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(trySave, SETTINGS_SAVE_DELAY_MS);
    }

    function trySave() {
        if (!settingsDirty) {
            return;
        }
        if (motion.mode === 'move' || motion.mode === 'stop') {
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

    // Remember a new job's speed and time limit.
    function startJob(job, rpm, stopAfter, value) {
        Object.assign(seq, {
            job,
            rpm,
            stopAfter,
            startMs: Date.now(),
            limitMs: stopAfter === 'minutes' ? Math.round(value * 60000) : 0,
        });
    }

    // Start a plain move to an angle in degrees from zero.
    function startMove(targetDeg, rpm) {
        startJob('move', rpm, 'never', 0);
        seq.moveTargetDeg = targetDeg;
        seq.moveTargetPos = degreesToHalfSteps(targetDeg);
        motionMoveTo(seq.moveTargetPos, rpm);
    }

    function sequencerSpin(rpm, dir, options) {
        const stopAfter = options.stopAfter === 'revs' ? 'count' : options.stopAfter;
        startJob('spin', rpm, stopAfter, options.stopValue);
        seq.spinDir = dir;
        if (stopAfter === 'count') {
            // A move that ramps into the last revolution, so it lands back on the starting angle.
            const turns = dir === 'cw' ? options.stopValue : -options.stopValue;
            seq.targetPos = relativePosition() + degreesToHalfSteps(turns * 360);
            motionMoveTo(seq.targetPos, rpm);
        } else {
            motionRun(rpm, dir);
        }
    }

    // Returns false if the two ends are the same.
    function sequencerSweep(rpm, options) {
        // The first end is the copy of From nearest the disk, and the other end is To - From beyond it.
        const here = halfStepsToDegrees(relativePosition());
        const fromDeg = here + angleDelta(here, options.fromDeg, 'shortest');
        const fromPos = degreesToHalfSteps(fromDeg);
        const toPos = degreesToHalfSteps(fromDeg + options.toDeg - options.fromDeg);
        if (fromPos === toPos) {
            return false;
        }
        const stopAfter = options.stopAfter === 'cycles' ? 'count' : options.stopAfter;
        startJob('sweep', rpm, stopAfter, options.stopValue);
        Object.assign(seq, {
            cycleLimit: stopAfter === 'count' ? Math.round(options.stopValue) : 0,
            fromPos,
            toPos,
            dwellMs: options.dwellMs,
            cyclesDone: 0,
            approaching: true,
            stage: 'travel',
            targetPos: fromPos,
        });
        motionMoveTo(fromPos, rpm);
        return true;
    }

    function sequencerMoveBy(deg, rpm) {
        // Build on the last target while that move is unfinished, or the disk still sits on it.
        const onLastTarget = (seq.job === 'move' && motionStateName() === 'moving')
            || relativePosition() === seq.moveTargetPos;
        startMove((onLastTarget ? seq.moveTargetDeg : halfStepsToDegrees(relativePosition())) + deg, rpm);
    }

    function sequencerMoveTo(deg, dir, rpm) {
        const here = halfStepsToDegrees(relativePosition());
        startMove(here + angleDelta(here, deg, dir), rpm);
    }

    // Change the speed of whatever is running.
    function sequencerSetSpeed(rpm) {
        seq.rpm = rpm;
        if (seq.job === 'move') {
            motionMoveTo(seq.moveTargetPos, rpm);
        } else if (seq.job === 'spin' && seq.stopAfter === 'count') {
            motionMoveTo(seq.targetPos, rpm);
        } else if (seq.job === 'spin') {
            motionRun(rpm, seq.spinDir);
        } else if (seq.job === 'sweep' && seq.stage === 'travel') {
            // While dwelling, the next leg picks up the new speed.
            motionMoveTo(seq.targetPos, rpm);
        }
    }

    function sequencerStop() {
        seq.job = 'none';
        motionStop();
    }

    function sequencerHalt() {
        seq.job = 'none';
        motionHalt();
    }

    // Targets are kept from zero, so they shift with it, and a running job keeps going to the same places.
    function sequencerSetZero() {
        const shift = Math.round(motion.position) - motion.zero;
        motion.zero = Math.round(motion.position);
        seq.targetPos -= shift;
        seq.fromPos -= shift;
        seq.toPos -= shift;
        seq.moveTargetPos -= shift;
        seq.moveTargetDeg -= halfStepsToDegrees(shift);
    }

    // Advance a sweep: arrive at an end, dwell, then head for the other end.
    function stepSweep(state, timeUp) {
        if (seq.stage === 'travel') {
            if (state !== 'idle') {
                return;
            }
            // Arrived. Coming back to the first end completes a cycle.
            if (!seq.approaching && seq.targetPos === seq.fromPos) {
                seq.cyclesDone++;
            }
            seq.approaching = false;
            if (seq.stopAfter === 'count' && seq.cyclesDone >= seq.cycleLimit) {
                seq.job = 'none';
                return;
            }
            seq.stage = 'dwell';
            seq.dwellStartMs = Date.now();
        }
        // Once time is up, a sweep stops at the next end it reaches.
        if (timeUp) {
            seq.job = 'none';
            return;
        }
        if (Date.now() - seq.dwellStartMs >= seq.dwellMs) {
            seq.targetPos = seq.targetPos === seq.fromPos ? seq.toPos : seq.fromPos;
            seq.stage = 'travel';
            motionMoveTo(seq.targetPos, seq.rpm);
        }
    }

    // Advance the running job, like handleSequencer() in sequencer.cpp.
    function handleSequencer() {
        const state = motionStateName();
        const timeUp = seq.stopAfter === 'minutes' && Date.now() - seq.startMs >= seq.limitMs;
        switch (seq.job) {
            case 'move':
                if (state === 'idle') {
                    seq.job = 'none';
                }
                break;
            case 'spin':
                if (seq.stopAfter === 'count' && state === 'idle') {
                    seq.job = 'none';
                } else if (timeUp) {
                    seq.job = 'none';
                    motionStop();
                }
                break;
            case 'sweep':
                stepSweep(state, timeUp);
                break;
        }
    }

    // Validate a message the way parseCommand() in server.cpp does.
    function parseCommand(msg) {
        const { cmd } = msg ?? {};
        switch (cmd) {
            case 'speed':
                return isNumber(msg.rpm) ? { cmd, rpm: msg.rpm } : { error: 'speed needs a number rpm' };
            case 'run': {
                if (msg.dir !== 'cw' && msg.dir !== 'ccw') {
                    return { error: 'run needs dir cw or ccw' };
                }
                const stop = parseStopFields(msg, 'revs');
                return stop.error ? stop : { cmd, dir: msg.dir, rpm: isNumber(msg.rpm) ? msg.rpm : undefined, spin: stop.fields };
            }
            case 'sweep': {
                const sweep = parseSweepFields(msg);
                return sweep.error ? sweep : { cmd, rpm: isNumber(msg.rpm) ? msg.rpm : undefined, sweep: sweep.fields };
            }
            case 'spinOptions': {
                const stop = parseStopFields(msg, 'revs');
                return stop.error ? stop : { cmd, spin: stop.fields };
            }
            case 'sweepOptions': {
                const sweep = parseSweepFields(msg);
                return sweep.error ? sweep : { cmd, sweep: sweep.fields };
            }
            case 'stop':
            case 'halt':
            case 'setZero':
            case 'wifiSetup':
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
            case 'presetSave': {
                const name = typeof msg.name === 'string' ? msg.name : '';
                if (name.length === 0 || Buffer.byteLength(name) > PRESET_NAME_BYTES) {
                    return { error: 'preset needs a name, up to 63 bytes' };
                }
                if (msg.mode !== 'spin' && msg.mode !== 'sweep') {
                    return { error: 'presetSave needs mode spin or sweep' };
                }
                return { cmd, name, mode: msg.mode };
            }
            case 'presetApply':
            case 'presetDelete':
                if (!Number.isInteger(msg.id) || msg.id < 0 || msg.id >= PRESET_SLOTS) {
                    return { error: 'no preset with that id' };
                }
                return { cmd, id: msg.id };
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

    function applySpinFields(fields) {
        Object.assign(settings.spin, fields);
        clampSpinOptions(settings.spin);
    }

    function applySweepFields(fields) {
        Object.assign(settings.sweep, fields);
        clampSweepOptions(settings.sweep);
    }

    // Run one command, the same way executeCommand() in server.cpp does.
    // Returns an error for the sender, or null.
    function execute(command) {
        switch (command.cmd) {
            case 'speed':
                settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                sequencerSetSpeed(settings.rpm);
                queueSettingsSave();
                break;
            case 'run':
                if (command.rpm !== undefined) {
                    settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                }
                settings.dir = command.dir;
                applySpinFields(command.spin);
                queueSettingsSave();
                sequencerSpin(settings.rpm, settings.dir, settings.spin);
                break;
            case 'spinOptions':
                applySpinFields(command.spin);
                queueSettingsSave();
                break;
            case 'sweepOptions':
                applySweepFields(command.sweep);
                queueSettingsSave();
                break;
            case 'sweep':
                if (command.rpm !== undefined) {
                    settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                }
                applySweepFields(command.sweep);
                queueSettingsSave();
                if (!sequencerSweep(settings.rpm, settings.sweep)) {
                    return 'From and To must be different angles';
                }
                break;
            case 'stop':
                sequencerStop();
                break;
            case 'halt':
                sequencerHalt();
                break;
            case 'moveBy':
                sequencerMoveBy(command.deg, settings.rpm);
                break;
            case 'moveTo':
                sequencerMoveTo(command.deg, command.dir, settings.rpm);
                break;
            case 'setZero':
                sequencerSetZero();
                break;
            case 'presetSave': {
                // The speed and the options of the tab the client had open. Same name replaces.
                let slot = presets.findIndex((preset) => preset?.name === command.name);
                if (slot < 0) {
                    slot = presets.indexOf(null);
                }
                if (slot < 0) {
                    return 'All 10 presets are used. Delete one first.';
                }
                presets[slot] = {
                    name: command.name,
                    mode: command.mode,
                    rpm: settings.rpm,
                    spin: { ...settings.spin },
                    sweep: { ...settings.sweep },
                };
                log(`Preset ${slot} saved: ${command.name}`);
                return { presetsChanged: true };
            }
            case 'presetApply': {
                // Loads the speed and options; the motion starts when the user presses Start.
                const preset = presets[command.id];
                if (!preset) {
                    return 'That preset was deleted';
                }
                settings.rpm = clamp(preset.rpm, MIN_RPM, settings.maxRpm);
                if (preset.mode === 'sweep') {
                    settings.sweep = { ...preset.sweep };
                } else {
                    settings.spin = { ...preset.spin };
                }
                sequencerSetSpeed(settings.rpm);
                queueSettingsSave();
                break;
            }
            case 'presetDelete':
                if (!presets[command.id]) {
                    return 'That preset was already deleted';
                }
                presets[command.id] = null;
                log(`Preset ${command.id} deleted`);
                return { presetsChanged: true };
            case 'wifiSetup':
                // Halt, then "restart" into setup: clients drop, as with the real reboot.
                sequencerHalt();
                motion.zero = 0;
                motion.position = 0;
                Object.assign(seq, { moveTargetDeg: 0, moveTargetPos: 0 });
                scanReadyAt = 0;
                setWifi({ mode: 'setup' });
                setTimeout(restart, 200);
                break;
            case 'settings':
                if (command.driveMode !== undefined) {
                    settings.driveMode = command.driveMode;
                }
                if (command.maxRpm !== undefined) {
                    settings.maxRpm = clamp(command.maxRpm, MIN_RPM, MAX_RPM_LIMIT);
                    if (settings.rpm > settings.maxRpm) {
                        settings.rpm = settings.maxRpm;
                        sequencerSetSpeed(settings.rpm);
                    }
                }
                if (command.accel !== undefined) {
                    settings.accel = clamp(command.accel, MIN_ACCEL, MAX_ACCEL);
                }
                queueSettingsSave();
                break;
        }
        return null;
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
        const result = execute(command);
        if (typeof result === 'string') {
            log(`[${client.remoteAddress}] ${text.slice(0, 80)} failed: ${result}`);
            client.send(JSON.stringify({ type: 'error', msg: result }));
        } else {
            log(`[${client.remoteAddress}] ${text.slice(0, 80)} -> ${describe()}`);
        }
        broadcast(stateJson());
        if (result?.presetsChanged) {
            broadcast(presetsJson());
        }
    }

    // Simulate the control task and the sequencer, and broadcast like handleStateBroadcast().
    let sinceBroadcast = 0;
    const timer = setInterval(() => {
        tick(TICK_MS / 1000);
        handleSequencer();
        sinceBroadcast += TICK_MS;
        if (sinceBroadcast >= STATE_INTERVAL_MS) {
            sinceBroadcast = 0;
            const state = motionStateName();
            const job = jobType();
            if (state !== 'idle' || job !== 'none' || state !== lastState || job !== lastJob) {
                broadcast(stateJson());
            }
            lastState = state;
            lastJob = job;
        }
    }, TICK_MS);
    timer.unref();

    return {
        onConnect(client) {
            log(`Client connected [${client.remoteAddress}]`);
            client.send(stateJson());
            client.send(presetsJson());
        },
        onMessage,
        onDisconnect(client) {
            log(`Client disconnected [${client.remoteAddress}]`);
        },
        describe,
        handleHttp,
        close() {
            clearInterval(timer);
            clearTimeout(saveTimer);
            clearTimeout(wifiTimer);
        },
    };
}
