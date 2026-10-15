// Emulates the firmware's v1 WebSocket protocol, as code/WebTurntable speaks it
// until Phase 2: three settings, broadcast to every client after each command.
// Matches the Phase 1 firmware, where CCW is 2 (the v1-esp8266 tag used 3).
//
//   client -> device  {"type":"stepping_speed","content":50}
//   device -> client  {"stepping_direction":1,"stepping_speed":50,"stepping_mode":0}

// Constants copied from turntable.h and server.cpp.
const MAX_DELAY = 20000;
const MIN_DELAY = 1800;
const TOTAL_SLIDER_STEPS = 100;
const DIRECTION = { CW: 0, OFF: 1, CCW: 2 };
const MODE = { FULL: 0, HALF: 1 };
const SETTINGS_SAVE_DELAY_MS = 750;

// 28BYJ-48 gear ratio ~63.684:1 (see docs/FIRMWARE.md).
const FULL_STEPS_PER_REV = 2037.886;

// Create a v1 device. broadcast(text) sends to every client; log(line) prints.
export function createDevice({ broadcast, log }) {
    const state = {
        stepping_direction: DIRECTION.OFF,
        stepping_speed: 0,
        stepping_mode: MODE.FULL,
    };
    let saveTimer = null;

    const pageContent = () => JSON.stringify(state);

    // Steps CW for 0, stops for OFF or speed 0, and steps CCW otherwise.
    function motion() {
        if (state.stepping_speed === 0 || state.stepping_direction === DIRECTION.OFF) {
            return 'stopped';
        }
        const multiplier = Math.floor((MAX_DELAY - MIN_DELAY) / TOTAL_SLIDER_STEPS);
        const stepDelayUs = MAX_DELAY - multiplier * state.stepping_speed;
        // Half-stepping waits half the delay per half-step, so both modes turn at the same rate.
        const fullStepUs = state.stepping_mode === MODE.HALF ? 2 * Math.floor(stepDelayUs / 2) : stepDelayUs;
        const rpm = 60e6 / (fullStepUs * FULL_STEPS_PER_REV);
        const dir = state.stepping_direction === DIRECTION.CW ? 'CW' : 'CCW';
        return `~${rpm.toFixed(2)} RPM ${dir}, ${(60 / rpm).toFixed(1)} s/rev`;
    }

    // Serial-log style summary plus the speed the v1 motor would actually turn at.
    function describe() {
        const dirName = { 0: 'CW', 1: 'OFF', 2: 'CCW' }[state.stepping_direction] ?? 'UNKNOWN';
        const modeName = state.stepping_mode === MODE.HALF ? 'HALF' : 'FULL';
        return `direction=${dirName}, speed=${state.stepping_speed}, mode=${modeName} (${motion()})`;
    }

    // Debounced like the firmware, so the log shows when flash would be written.
    function queueSettingsSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => log(`Settings saved: ${describe()}`), SETTINGS_SAVE_DELAY_MS);
    }

    // Store one validated setting, queueing a save only if it changed.
    function apply(key, value) {
        if (state[key] !== value) {
            state[key] = value;
            queueSettingsSave();
        }
    }

    // Validate a command the way server.cpp does, then broadcast the state.
    function onMessage(client, text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            log(`Ignored non-JSON message: ${text.slice(0, 80)}`);
            return;
        }
        // Like the firmware, anything that isn't an integer becomes -1 and fails the range checks.
        const content = Number.isInteger(msg?.content) ? msg.content : -1;

        switch (msg?.type) {
            case 'stepping_direction':
                if (content >= 0 && content <= DIRECTION.CCW) {
                    apply('stepping_direction', content);
                }
                break;
            case 'stepping_speed':
                if (content >= 0) {
                    apply('stepping_speed', Math.min(content, TOTAL_SLIDER_STEPS));
                }
                break;
            case 'stepping_mode':
                if (content >= 0 && content <= MODE.HALF) {
                    apply('stepping_mode', content);
                }
                break;
            default:
                log(`Ignored message type: ${msg?.type}`);
                return;
        }
        log(`[${client.remoteAddress}] ${msg.type}=${content} -> ${describe()}`);
        broadcast(pageContent());
    }

    return {
        onConnect(client) {
            log(`Client connected [${client.remoteAddress}]`);
            log(`Current state: ${describe()}`);
            client.send(pageContent());
        },
        onMessage,
        onDisconnect(client) {
            log(`Client disconnected [${client.remoteAddress}]`);
        },
        describe,
        close() {
            clearTimeout(saveTimer);
        },
    };
}
