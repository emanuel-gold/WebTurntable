// Emulates the firmware's v2 WebSocket protocol (docs/FIRMWARE.md): JSON commands
// with a "cmd" field, and a full "state" broadcast after every command and 10 times
// a second while the disk moves. The motion is simulated with the same ramp logic
// as code/WebTurntable/motion.cpp, so the UI sees realistic angles and speeds.
// Jobs (spins with a stop condition, sweeps, photo and video captures) follow
// sequencer.cpp, and presets follow presets.cpp, kept in memory for as long as the
// mock runs.

// The Bluetooth shutter (shutter.cpp) is faked: a phone is either connected or not
// (the `shutter` option, or setShutterPhone()), and presses are counted and logged.

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
const MAX_PHOTO_SHOTS = 720;
const MIN_PHOTO_STEP_DEG = 0.1;
const MAX_PHOTO_STEP_DEG = 360;
const MAX_WAIT_MS = 60000;

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
// Milliseconds from a JSON number, kept inside [0, high], like toMs() in server.cpp.
const toMs = (value, high) => (value <= 0 ? 0 : Math.min(Math.round(value), high));

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

// Keep photo options inside the limits, like clampPhotoOptions() in sequencer.cpp.
function clampPhotoOptions(options) {
    options.shots = clamp(options.shots, 1, MAX_PHOTO_SHOTS);
    options.stepDeg = clampFinite(options.stepDeg, MIN_PHOTO_STEP_DEG, MAX_PHOTO_STEP_DEG, 10);
    options.settleMs = Math.min(options.settleMs, MAX_WAIT_MS);
    options.afterMs = Math.min(options.afterMs, MAX_WAIT_MS);
    options.delayMs = Math.min(options.delayMs, MAX_WAIT_MS);
}

// Keep video options inside the limits, like clampVideoOptions() in sequencer.cpp.
function clampVideoOptions(options) {
    options.leadInMs = Math.min(options.leadInMs, MAX_WAIT_MS);
    options.leadOutMs = Math.min(options.leadOutMs, MAX_WAIT_MS);
    options.delayMs = Math.min(options.delayMs, MAX_WAIT_MS);
}

const spinJson = (options) => ({ stopAfter: options.stopAfter, stopValue: round(options.stopValue, 2) });
const sweepJson = (options) => ({
    fromDeg: round(options.fromDeg, 1),
    toDeg: round(options.toDeg, 1),
    dwellMs: options.dwellMs,
    stopAfter: options.stopAfter,
    stopValue: round(options.stopValue, 2),
});
const photoJson = (options) => ({ ...options, stepDeg: round(options.stepDeg, 2) });
const videoJson = (options) => ({ ...options });

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

// Copy the optional number fields of msg named in keys; false if one isn't a number.
function readNumbers(msg, keys, fields) {
    for (const key of keys) {
        if (!isAbsent(msg[key])) {
            if (!isNumber(msg[key])) {
                return false;
            }
            fields[key] = msg[key];
        }
    }
    return true;
}

// Read the optional sweep option fields, like parseSweepFields() in server.cpp.
function parseSweepFields(msg) {
    const fields = {};
    if (!readNumbers(msg, ['fromDeg', 'toDeg', 'dwellMs'], fields)) {
        return { error: 'fromDeg, toDeg and dwellMs must be numbers' };
    }
    if (fields.dwellMs !== undefined) {
        fields.dwellMs = toMs(fields.dwellMs, MAX_DWELL_MS);
    }
    const stop = parseStopFields(msg, 'cycles');
    return stop.error ? stop : { fields: { ...fields, ...stop.fields } };
}

// Read the optional photo option fields, like parsePhotoFields() in server.cpp.
function parsePhotoFields(msg) {
    const fields = {};
    if (!readNumbers(msg, ['shots', 'stepDeg', 'settleMs', 'afterMs', 'delayMs'], fields)) {
        return { error: 'shots, stepDeg, settleMs, afterMs and delayMs must be numbers' };
    }
    if (fields.shots !== undefined) {
        fields.shots = fields.shots <= 1 ? 1 : Math.min(Math.round(fields.shots), MAX_PHOTO_SHOTS);
    }
    for (const key of ['settleMs', 'afterMs', 'delayMs']) {
        if (fields[key] !== undefined) {
            fields[key] = toMs(fields[key], MAX_WAIT_MS);
        }
    }
    if (!isAbsent(msg.dir)) {
        if (msg.dir !== 'cw' && msg.dir !== 'ccw') {
            return { error: 'dir must be cw or ccw' };
        }
        fields.dir = msg.dir;
    }
    for (const key of ['returnToStart', 'pressShutter']) {
        if (!isAbsent(msg[key])) {
            if (typeof msg[key] !== 'boolean') {
                return { error: 'returnToStart and pressShutter must be true or false' };
            }
            fields[key] = msg[key];
        }
    }
    return { fields };
}

// Read the optional video option fields, like parseVideoFields() in server.cpp.
function parseVideoFields(msg) {
    const fields = {};
    if (!isAbsent(msg.motion)) {
        if (msg.motion !== 'spin' && msg.motion !== 'sweep') {
            return { error: 'motion must be spin or sweep' };
        }
        fields.motion = msg.motion;
    }
    if (!isAbsent(msg.dir)) {
        if (msg.dir !== 'cw' && msg.dir !== 'ccw') {
            return { error: 'dir must be cw or ccw' };
        }
        fields.dir = msg.dir;
    }
    if (!readNumbers(msg, ['leadInMs', 'leadOutMs', 'delayMs'], fields)) {
        return { error: 'leadInMs, leadOutMs and delayMs must be numbers' };
    }
    for (const key of ['leadInMs', 'leadOutMs', 'delayMs']) {
        if (fields[key] !== undefined) {
            fields[key] = toMs(fields[key], MAX_WAIT_MS);
        }
    }
    return { fields };
}

// Read the optional shutter setting fields, like parseShutterFields() in server.cpp.
function parseShutterFields(msg) {
    const fields = {};
    if (!isAbsent(msg.enabled)) {
        if (typeof msg.enabled !== 'boolean') {
            return { error: 'enabled must be true or false' };
        }
        fields.enabled = msg.enabled;
    }
    if (!isAbsent(msg.key)) {
        if (msg.key !== 'volumeUp' && msg.key !== 'volumeDown') {
            return { error: 'key must be volumeUp or volumeDown' };
        }
        fields.key = msg.key;
    }
    return { fields };
}

// Create a v2 device. broadcast(text) sends to every client; log(line) prints.
// shutter is 'connected' (a paired phone in range) or 'none'.
export function createDevice({ broadcast, log, wifi: initialWifi = 'lan', restart = () => {}, shutter = 'connected' }) {
    const settings = {
        rpm: DEFAULT_RPM,
        dir: 'cw',
        driveMode: 'half',
        maxRpm: DEFAULT_MAX_RPM,
        accel: DEFAULT_ACCEL,
        spin: { stopAfter: 'never', stopValue: 1 },
        sweep: { fromDeg: -30, toDeg: 30, dwellMs: 500, stopAfter: 'never', stopValue: 4 },
        photo: {
            shots: 36, stepDeg: 10, settleMs: 800, afterMs: 500, dir: 'cw',
            returnToStart: true, pressShutter: true, delayMs: 5000,
        },
        video: { motion: 'spin', dir: 'cw', leadInMs: 1000, leadOutMs: 1000, delayMs: 5000 },
        shutter: { enabled: true, key: 'volumeUp' },
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

    // The capture layer of sequencer.cpp. type is none, photo or video.
    const cap = {
        type: 'none',
        stage: 'delay',
        stageStartMs: 0,
        paused: false,
        needsShutter: false,
        recording: false,
        key: 'volumeUp',
        rpm: DEFAULT_RPM,
        photo: null,
        shotIndex: 0,
        startDeg: 0,
        video: null,
        spin: null,
        sweep: null,
    };

    // Fake shutter.cpp: a phone in range connects whenever the shutter is enabled.
    const phone = { nearby: shutter === 'connected', presses: 0 };
    const shutterConnected = () => settings.shutter.enabled && phone.nearby;

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
    const jobType = () => {
        if (cap.type !== 'none') {
            return cap.type;
        }
        return seq.job === 'spin' || seq.job === 'sweep' ? seq.job : 'none';
    };

    function angle() {
        const deg = ((relativePosition() * 360) / HALF_STEPS_PER_REV) % 360;
        return deg < 0 ? deg + 360 : deg;
    }

    // What's left of the motion layer's spin or sweep, like addMotionProgress() in server.cpp.
    function motionProgress(job) {
        if (seq.job === 'spin' && seq.stopAfter === 'count') {
            job.revsLeft = round(Math.abs(seq.targetPos - relativePosition()) / HALF_STEPS_PER_REV, 2);
        }
        if (seq.job === 'sweep') {
            job.cycle = seq.cyclesDone + 1;
            if (seq.stopAfter === 'count') {
                job.cycles = seq.cycleLimit;
            }
        }
        if ((seq.job === 'spin' || seq.job === 'sweep') && seq.stopAfter === 'minutes') {
            const elapsed = Date.now() - seq.startMs;
            job.secondsLeft = elapsed >= seq.limitMs ? 0 : Math.ceil((seq.limitMs - elapsed) / 1000);
        }
        return job;
    }

    // The running job and what's left of it, like stateJson() in server.cpp.
    function jobJson() {
        const type = jobType();
        if (type === 'none') {
            return null;
        }
        if (type === 'spin' || type === 'sweep') {
            return motionProgress({ type });
        }
        const job = { type, stage: cap.stage };
        if (cap.stage === 'delay') {
            const delayMs = cap.type === 'photo' ? cap.photo.delayMs : cap.video.delayMs;
            const elapsed = cap.paused ? 0 : Date.now() - cap.stageStartMs;
            job.startsIn = elapsed >= delayMs ? 0 : Math.ceil((delayMs - elapsed) / 1000);
        }
        job.paused = cap.paused;
        if (cap.needsShutter) {
            job.needsShutter = true;
        }
        if (type === 'photo') {
            job.shot = Math.min(cap.shotIndex + 1, cap.photo.shots);
            job.shots = cap.photo.shots;
        } else {
            job.motion = cap.video.motion;
            if (cap.stage === 'motion') {
                motionProgress(job);
            }
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
            spinning: jobType() === 'spin',
            job: jobJson(),
            spin: spinJson(settings.spin),
            sweep: sweepJson(settings.sweep),
            photo: photoJson(settings.photo),
            video: videoJson(settings.video),
            shutter: {
                enabled: settings.shutter.enabled,
                key: settings.shutter.key,
                connected: shutterConnected(),
                ready: shutterConnected(),
            },
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
                maxShots: MAX_PHOTO_SHOTS,
                minStepDeg: MIN_PHOTO_STEP_DEG,
                maxStepDeg: MAX_PHOTO_STEP_DEG,
                maxWaitMs: MAX_WAIT_MS,
            },
        });
    }

    // Like presetsJson() in server.cpp: a video brings its spin or sweep, nested.
    function presetOptionsJson(preset) {
        switch (preset.mode) {
            case 'sweep':
                return sweepJson(preset.sweep);
            case 'photo':
                return photoJson(preset.photo);
            case 'video':
                return preset.video.motion === 'sweep'
                    ? { ...videoJson(preset.video), sweep: sweepJson(preset.sweep) }
                    : { ...videoJson(preset.video), spin: spinJson(preset.spin) };
            default:
                return spinJson(preset.spin);
        }
    }

    function presetsJson() {
        const list = presets.flatMap((preset, id) => (preset === null ? [] : [{
            id,
            name: preset.name,
            mode: preset.mode,
            rpm: round(preset.rpm, 2),
            ...presetOptionsJson(preset),
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
        const { rpm, dir, driveMode, maxRpm, accel, spin, sweep, photo, video } = settings;
        const job = jobType();
        return `rpm=${rpm.toFixed(2)}, dir=${dir}, mode=${driveMode}, maxRpm=${maxRpm}, accel=${accel}, ` +
            `spin=${spin.stopAfter} ${spin.stopValue}, sweep=${sweep.fromDeg}..${sweep.toDeg} dwell ${sweep.dwellMs} ` +
            `${sweep.stopAfter} ${sweep.stopValue}, photo=${photo.shots}x${photo.stepDeg}, video=${video.motion}, ` +
            `shutter=${shutterConnected() ? 'connected' : 'no phone'}; ` +
            `${job === 'none' ? '' : `${job} job${cap.type !== 'none' ? ` (${cap.stage})` : ''}, `}` +
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

    // Press the fake shutter. Returns false if no phone is ready, like shutterPress().
    function shutterPress(key) {
        if (!shutterConnected()) {
            return false;
        }
        phone.presses++;
        log(`Shutter: ${key === 'volumeDown' ? 'Volume Down' : 'Volume Up'} (press ${phone.presses})`);
        return true;
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

    function startSpin(rpm, dir, options) {
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

    // Where a sweep starting now would turn, or null if both ends are the same half-step.
    function sweepEnds(options) {
        // The first end is the copy of From nearest the disk, and the other end is To - From beyond it.
        const here = halfStepsToDegrees(relativePosition());
        const fromDeg = here + angleDelta(here, options.fromDeg, 'shortest');
        const fromPos = degreesToHalfSteps(fromDeg);
        const toPos = degreesToHalfSteps(fromDeg + options.toDeg - options.fromDeg);
        return fromPos === toPos ? null : { fromPos, toPos };
    }

    function startSweep(rpm, options, { fromPos, toPos }) {
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
    }

    // Drop a capture because something else is starting. A recording video gets a last press.
    function cancelCapture() {
        if (cap.type === 'video' && cap.recording) {
            shutterPress(cap.key);
            log('Video capture cancelled: stopped the recording');
        }
        Object.assign(cap, { type: 'none', recording: false, paused: false });
    }

    function enterStage(stage) {
        cap.stage = stage;
        cap.stageStartMs = Date.now();
    }

    // Press for a capture; with no phone ready, pause until the user resumes.
    function pressCaptureShutter() {
        if (shutterPress(cap.key)) {
            return true;
        }
        log('Capture paused: no phone ready for the shutter');
        cap.paused = true;
        cap.needsShutter = true;
        return false;
    }

    function finishCapture() {
        log(cap.type === 'photo' ? 'Photo capture done' : 'Video capture done');
        Object.assign(cap, { type: 'none', paused: false });
    }

    function beginCapture(type, rpm, key) {
        cancelCapture();
        seq.job = 'none';
        motionStop();
        Object.assign(cap, {
            type, rpm, key, paused: false, needsShutter: false, recording: false, shotIndex: 0,
        });
        enterStage('delay');
    }

    // Advance a photo capture, like stepPhoto() in sequencer.cpp.
    function stepPhoto(motionDone, elapsed) {
        const photo = cap.photo;
        switch (cap.stage) {
            case 'delay':
                if (cap.paused || !motionDone || elapsed < photo.delayMs) {
                    return;
                }
                cap.startDeg = halfStepsToDegrees(relativePosition());
                enterStage('settle');
                break;
            case 'move':
                if (motionDone) {
                    enterStage('settle');
                }
                break;
            case 'settle':
                if (cap.paused || elapsed < photo.settleMs) {
                    return;
                }
                if (photo.pressShutter && !pressCaptureShutter()) {
                    return;
                }
                enterStage('shot');
                break;
            case 'shot':
                if (cap.paused || elapsed < photo.afterMs) {
                    return;
                }
                cap.shotIndex++;
                if (cap.shotIndex < photo.shots) {
                    const sign = photo.dir === 'cw' ? 1 : -1;
                    startMove(cap.startDeg + sign * cap.shotIndex * photo.stepDeg, cap.rpm);
                    enterStage('move');
                } else if (photo.returnToStart) {
                    const here = halfStepsToDegrees(relativePosition());
                    startMove(here + angleDelta(here, cap.startDeg, 'shortest'), cap.rpm);
                    enterStage('return');
                } else {
                    finishCapture();
                }
                break;
            case 'return':
                if (motionDone) {
                    finishCapture();
                }
                break;
        }
    }

    // Advance a video capture, like stepVideo() in sequencer.cpp.
    function stepVideo(motionDone, elapsed) {
        const video = cap.video;
        switch (cap.stage) {
            case 'delay':
                if (cap.paused || !motionDone || elapsed < video.delayMs || !pressCaptureShutter()) {
                    return;
                }
                cap.recording = true;
                enterStage('leadIn');
                break;
            case 'leadIn': {
                if (elapsed < video.leadInMs) {
                    return;
                }
                if (video.motion === 'sweep') {
                    const ends = sweepEnds(cap.sweep);
                    if (ends) {
                        startSweep(cap.rpm, cap.sweep, ends);
                    }
                } else {
                    startSpin(cap.rpm, video.dir, cap.spin);
                }
                enterStage('motion');
                break;
            }
            case 'motion':
                if (motionDone) {
                    enterStage('leadOut');
                }
                break;
            case 'leadOut':
                if (elapsed < video.leadOutMs) {
                    return;
                }
                shutterPress(cap.key);
                cap.recording = false;
                finishCapture();
                break;
        }
    }

    function sequencerSpin(rpm, dir, options) {
        cancelCapture();
        startSpin(rpm, dir, options);
    }

    // Returns false if the two ends are the same.
    function sequencerSweep(rpm, options) {
        const ends = sweepEnds(options);
        if (!ends) {
            return false;
        }
        cancelCapture();
        startSweep(rpm, options, ends);
        return true;
    }

    // Returns an error, or null.
    function sequencerPhoto(rpm, options, key) {
        if (options.pressShutter && !shutterConnected()) {
            return 'No phone is connected to the shutter. Pair it, or turn off Press the shutter.';
        }
        beginCapture('photo', rpm, key);
        cap.photo = { ...options };
        return null;
    }

    // Returns an error, or null.
    function sequencerVideo(rpm, options, spin, sweep, key) {
        if (!shutterConnected()) {
            return 'No phone is connected to the shutter';
        }
        if (options.motion === 'sweep' && !sweepEnds(sweep)) {
            return 'From and To must be different angles';
        }
        beginCapture('video', rpm, key);
        Object.assign(cap, { video: { ...options }, spin: { ...spin }, sweep: { ...sweep } });
        return null;
    }

    function sequencerMoveBy(deg, rpm) {
        cancelCapture();
        // Build on the last target while that move is unfinished, or the disk still sits on it.
        const onLastTarget = (seq.job === 'move' && motionStateName() === 'moving')
            || relativePosition() === seq.moveTargetPos;
        startMove((onLastTarget ? seq.moveTargetDeg : halfStepsToDegrees(relativePosition())) + deg, rpm);
    }

    function sequencerMoveTo(deg, dir, rpm) {
        cancelCapture();
        const here = halfStepsToDegrees(relativePosition());
        startMove(here + angleDelta(here, deg, dir), rpm);
    }

    // Change the speed of whatever is running.
    function sequencerSetSpeed(rpm) {
        seq.rpm = rpm;
        cap.rpm = rpm;
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
        cancelCapture();
        seq.job = 'none';
        motionStop();
    }

    function sequencerHalt() {
        cancelCapture();
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
        cap.startDeg -= halfStepsToDegrees(shift);
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

        if (cap.type === 'none') {
            return;
        }
        const motionDone = seq.job === 'none' && motionStateName() === 'idle';
        const elapsed = Date.now() - cap.stageStartMs;
        if (cap.type === 'photo') {
            stepPhoto(motionDone, elapsed);
        } else {
            stepVideo(motionDone, elapsed);
        }
    }

    // Validate a message the way parseCommand() in server.cpp does.
    function parseCommand(msg) {
        const { cmd } = msg ?? {};
        const rpm = isNumber(msg?.rpm) ? msg.rpm : undefined;
        switch (cmd) {
            case 'speed':
                return isNumber(msg.rpm) ? { cmd, rpm: msg.rpm } : { error: 'speed needs a number rpm' };
            case 'run': {
                if (msg.dir !== 'cw' && msg.dir !== 'ccw') {
                    return { error: 'run needs dir cw or ccw' };
                }
                const stop = parseStopFields(msg, 'revs');
                return stop.error ? stop : { cmd, dir: msg.dir, rpm, fields: stop.fields };
            }
            case 'spinOptions': {
                const stop = parseStopFields(msg, 'revs');
                return stop.error ? stop : { cmd, fields: stop.fields };
            }
            case 'sweep':
            case 'sweepOptions': {
                const sweep = parseSweepFields(msg);
                return sweep.error ? sweep : { cmd, rpm, fields: sweep.fields };
            }
            case 'photo':
            case 'photoOptions': {
                const photo = parsePhotoFields(msg);
                return photo.error ? photo : { cmd, rpm, fields: photo.fields };
            }
            case 'video':
            case 'videoOptions': {
                const video = parseVideoFields(msg);
                return video.error ? video : { cmd, rpm, fields: video.fields };
            }
            case 'shutter': {
                const shutterFields = parseShutterFields(msg);
                return shutterFields.error ? shutterFields : { cmd, fields: shutterFields.fields };
            }
            case 'stop':
            case 'halt':
            case 'setZero':
            case 'wifiSetup':
            case 'capturePause':
            case 'captureResume':
            case 'shutterTest':
            case 'shutterForget':
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
                if (!['spin', 'sweep', 'photo', 'video'].includes(msg.mode)) {
                    return { error: 'presetSave needs mode spin, sweep, photo or video' };
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

    // Take an rpm a start command carries as the new speed setting.
    function applyRpm(command) {
        if (command.rpm !== undefined) {
            settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
        }
    }

    function applyFields(options, fields, clampOptions) {
        Object.assign(options, fields);
        clampOptions(options);
    }

    // Run one command, the same way executeCommand() in server.cpp does.
    // Returns an error for the sender, { presetsChanged: true }, or null.
    function execute(command) {
        switch (command.cmd) {
            case 'speed':
                settings.rpm = clamp(command.rpm, MIN_RPM, settings.maxRpm);
                sequencerSetSpeed(settings.rpm);
                queueSettingsSave();
                break;
            case 'run':
                applyRpm(command);
                settings.dir = command.dir;
                applyFields(settings.spin, command.fields, clampSpinOptions);
                queueSettingsSave();
                sequencerSpin(settings.rpm, settings.dir, settings.spin);
                break;
            case 'spinOptions':
                applyFields(settings.spin, command.fields, clampSpinOptions);
                queueSettingsSave();
                break;
            case 'sweepOptions':
                applyFields(settings.sweep, command.fields, clampSweepOptions);
                queueSettingsSave();
                break;
            case 'sweep':
                applyRpm(command);
                applyFields(settings.sweep, command.fields, clampSweepOptions);
                queueSettingsSave();
                if (!sequencerSweep(settings.rpm, settings.sweep)) {
                    return 'From and To must be different angles';
                }
                break;
            case 'photoOptions':
                applyFields(settings.photo, command.fields, clampPhotoOptions);
                queueSettingsSave();
                break;
            case 'photo':
                applyRpm(command);
                applyFields(settings.photo, command.fields, clampPhotoOptions);
                queueSettingsSave();
                return sequencerPhoto(settings.rpm, settings.photo, settings.shutter.key);
            case 'videoOptions':
                applyFields(settings.video, command.fields, clampVideoOptions);
                queueSettingsSave();
                break;
            case 'video':
                applyRpm(command);
                applyFields(settings.video, command.fields, clampVideoOptions);
                queueSettingsSave();
                return sequencerVideo(settings.rpm, settings.video, settings.spin, settings.sweep, settings.shutter.key);
            case 'capturePause':
                if (cap.type !== 'photo') {
                    return 'No photo capture is running';
                }
                cap.paused = true;
                break;
            case 'captureResume':
                if (cap.type === 'none' || !cap.paused) {
                    return 'Nothing is paused';
                }
                // Start the stage's wait over: the disk settles again, and the start delay runs again.
                Object.assign(cap, { paused: false, needsShutter: false, stageStartMs: Date.now() });
                break;
            case 'shutter':
                Object.assign(settings.shutter, command.fields);
                queueSettingsSave();
                break;
            case 'shutterTest':
                if (!shutterPress(settings.shutter.key)) {
                    return 'No phone is connected to the shutter';
                }
                break;
            case 'shutterForget':
                phone.nearby = false;
                log('Shutter: forgot all paired phones');
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
                    photo: { ...settings.photo },
                    video: { ...settings.video },
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
                } else if (preset.mode === 'photo') {
                    settings.photo = { ...preset.photo };
                } else if (preset.mode === 'video') {
                    // A video brings the spin or sweep it records.
                    settings.video = { ...preset.video };
                    if (preset.video.motion === 'sweep') {
                        settings.sweep = { ...preset.sweep };
                    } else {
                        settings.spin = { ...preset.spin };
                    }
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
        // A paired phone comes into range (true) or leaves (false), like the real shutter connecting.
        setShutterPhone(nearby) {
            phone.nearby = nearby;
            log(`Shutter: phone ${shutterConnected() ? 'connected' : 'disconnected'}`);
            broadcast(stateJson());
        },
        get shutterPhone() {
            return phone.nearby;
        },
        get shutterPresses() {
            return phone.presses;
        },
        close() {
            clearInterval(timer);
            clearTimeout(saveTimer);
            clearTimeout(wifiTimer);
        },
    };
}
