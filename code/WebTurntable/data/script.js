// Web UI for the turntable. Talks the v2 protocol over /ws (see docs/FIRMWARE.md):
// sends {"cmd": ...} commands and renders every {"type":"state"} and {"type":"presets"}
// the device broadcasts.

var gateway = `ws://${window.location.host}/ws`;
var websocket;
var state = null;
var presets = [];
var pointerTurns = 0;       // Unwrapped pointer rotation, so it never spins the long way round
var lastSpeedSent = 0;
var toastTimer;
var activeTab = 'spin';
var lastJobType = null;
var pendingPresetName = null;   // Saved from this page, waiting for the presets list to confirm

var el = function (id) { return document.getElementById(id); };

function initWebSocket() {
    websocket = new WebSocket(gateway);
    websocket.onopen = onOpen;
    websocket.onclose = onClose;
    websocket.onmessage = onMessage;
}

function onOpen() {
    setConnected(true);
}

function onClose() {
    setConnected(false);
    setTimeout(initWebSocket, 2000);
}

function setConnected(connected) {
    var pill = el('connection');
    pill.textContent = connected ? 'Connected' : 'Reconnecting…';
    pill.classList.toggle('offline', !connected);
    document.body.classList.toggle('offline', !connected);
}

function onMessage(event) {
    var msg = JSON.parse(event.data);
    if (msg.type === 'state') {
        state = msg;
        render();
    } else if (msg.type === 'presets') {
        presets = msg.presets;
        renderPresets();
    } else if (msg.type === 'error') {
        showToast(msg.msg);
    }
}

function send(command) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(command));
    } else {
        showToast('Not connected');
    }
}

function showToast(text) {
    var toast = el('toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2500);
}

// Don't overwrite a control the user is editing.
function isEditing(input) {
    return document.activeElement === input || input.dataset.dragging === 'true';
}

function render() {
    var s = state;

    // Dial and readout
    el('angle').textContent = s.angle.toFixed(1) + '°';
    var delta = ((s.angle - pointerTurns) % 360 + 540) % 360 - 180;
    pointerTurns += delta;
    el('pointer').style.transform = 'rotate(' + pointerTurns + 'deg)';

    var speed = Math.abs(s.speed);
    var motionText = s.job ? { spin: 'Spinning', sweep: 'Sweeping' }[s.job.type] : {
        idle: 'Stopped',
        running: 'Spinning',
        moving: 'Moving',
        stopping: 'Stopping'
    }[s.motion] || s.motion;
    if (s.motion !== 'idle') {
        motionText += ' · ' + speed.toFixed(1) + ' RPM ' + (s.speed >= 0 ? 'CW' : 'CCW');
    } else if (s.job) {
        motionText += ' · pause';
    }
    el('motion').textContent = motionText;
    var progress = jobText(s.job);
    el('job').textContent = progress;
    el('job').hidden = progress === '';

    // A job started from any phone brings its tab forward
    var jobType = s.job ? s.job.type : null;
    if (jobType && jobType !== lastJobType) {
        showTab(jobType);
    }
    lastJobType = jobType;

    // Speed slider: linear in RPM, up to the max speed setting
    var slider = el('rpm');
    slider.min = s.limits.minRpm;
    slider.max = s.settings.maxRpm;
    if (!isEditing(slider)) {
        slider.value = s.rpm;
    }
    showSpeed(isEditing(slider) ? parseFloat(slider.value) : s.rpm);

    // Direction buttons light up while spinning that way
    el('run-cw').classList.toggle('active', s.spinning && s.dir === 'cw');
    el('run-ccw').classList.toggle('active', s.spinning && s.dir === 'ccw');

    // Spin and sweep options
    setIfIdle(el('spin-stop-after'), s.spin.stopAfter);
    setIfIdle(el('spin-stop-value'), formatNumber(s.spin.stopValue));
    setIfIdle(el('sweep-from'), formatNumber(s.sweep.fromDeg));
    setIfIdle(el('sweep-to'), formatNumber(s.sweep.toDeg));
    setIfIdle(el('sweep-dwell'), formatNumber(s.sweep.dwellMs / 1000));
    setIfIdle(el('sweep-stop-after'), s.sweep.stopAfter);
    setIfIdle(el('sweep-stop-value'), formatNumber(s.sweep.stopValue));
    showStopValue('spin');
    showStopValue('sweep');
    showSweepSummary();
    var sweeping = jobType === 'sweep';
    el('sweep-start').textContent = sweeping ? 'Stop sweep' : 'Start sweep';
    el('sweep-start').classList.toggle('active', sweeping);

    // Settings
    document.querySelectorAll('[data-mode]').forEach(function (button) {
        var active = button.dataset.mode === s.settings.driveMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', active);
    });
    setIfIdle(el('accel'), s.settings.accel);
    setIfIdle(el('max-rpm'), s.settings.maxRpm);
    el('accel').min = s.limits.minAccel;
    el('accel').max = s.limits.maxAccel;
    el('max-rpm').min = s.limits.minRpm;
    el('max-rpm').max = s.limits.maxRpm;

    el('stop').textContent = s.motion === 'stopping' ? 'HALT NOW' : 'STOP';

    renderWifi(s.wifi);
}

// What's left of a spin or sweep, for the line under the angle.
function jobText(job) {
    if (!job) {
        return '';
    }
    var parts = [];
    if (job.type === 'sweep') {
        parts.push('Cycle ' + job.cycle + (job.cycles ? ' of ' + job.cycles : ''));
    }
    if (job.revsLeft !== undefined) {
        parts.push(job.revsLeft.toFixed(1) + ' rev left');
    }
    if (job.secondsLeft !== undefined) {
        parts.push(job.secondsLeft > 0 ? formatTime(job.secondsLeft) + ' left' : 'finishing');
    }
    return parts.join(' · ');
}

function formatTime(seconds) {
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
}

// Up to two decimals, without trailing zeros.
function formatNumber(value) {
    return String(Math.round(value * 100) / 100);
}

function formatDeg(value) {
    return formatNumber(value).replace('-', '−') + '°';
}

function showTab(tab) {
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (button) {
        var selected = button.dataset.tab === tab;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', selected);
    });
    el('panel-spin').hidden = tab !== 'spin';
    el('panel-sweep').hidden = tab !== 'sweep';
    el('preset-save-button').textContent = tab === 'sweep' ? 'Save sweep' : 'Save spin';
    try {
        localStorage.setItem('tab', tab);
    } catch (e) {
        // Private browsing: the tab just isn't remembered
    }
}

// The number next to "Run" only shows when there's a limit.
function showStopValue(mode) {
    el(mode + '-stop-value').hidden = el(mode + '-stop-after').value === 'never';
}

function showSweepSummary() {
    var from = parseFloat(el('sweep-from').value);
    var to = parseFloat(el('sweep-to').value);
    var text;
    if (!isFinite(from) || !isFinite(to)) {
        text = 'Enter both angles.';
    } else if (from === to) {
        text = 'From and To must be different angles.';
    } else {
        text = 'Goes to ' + formatDeg(from) + ', then swings ' + formatDeg(Math.abs(to - from)) + ' ' +
            (to > from ? 'clockwise' : 'counter-clockwise') + ' and back.';
    }
    el('sweep-summary').textContent = text;
}

function renderWifi(wifi) {
    if (!wifi) {
        return;
    }
    var text;
    if (wifi.mode === 'lan') {
        text = wifi.ip ? wifi.ssid + ' · ' + wifi.ip + ' · ' + wifi.rssi + ' dBm' : wifi.ssid + ' (reconnecting)';
    } else if (wifi.mode === 'ap') {
        text = 'Access point (not saved)';
    } else {
        text = wifi.mode;
    }
    el('wifi-info').textContent = text;
}

function renderPresets() {
    var list = el('preset-list');
    list.textContent = '';
    presets.forEach(function (preset) {
        var name = document.createElement('span');
        name.className = 'preset-name';
        name.textContent = preset.name;
        var summary = document.createElement('span');
        summary.className = 'preset-summary';
        summary.textContent = presetSummary(preset);
        var load = document.createElement('button');
        load.className = 'preset-load';
        load.append(name, summary);
        load.addEventListener('click', function () { loadPreset(preset); });

        var remove = document.createElement('button');
        remove.className = 'preset-delete';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', 'Delete ' + preset.name);
        remove.addEventListener('click', function () { onDeletePreset(remove, preset); });

        var item = document.createElement('li');
        item.className = 'preset';
        item.append(load, remove);
        list.appendChild(item);
    });
    el('presets-empty').hidden = presets.length > 0;

    if (pendingPresetName !== null && presets.some(function (p) { return p.name === pendingPresetName; })) {
        showToast('Saved “' + pendingPresetName + '”');
        el('preset-name').value = '';
        pendingPresetName = null;
    }
}

function presetSummary(preset) {
    var speed = formatNumber(preset.rpm) + ' RPM';
    var length = {
        revs: formatNumber(preset.stopValue) + ' rev',
        cycles: formatNumber(preset.stopValue) + (preset.stopValue === 1 ? ' cycle' : ' cycles'),
        minutes: formatNumber(preset.stopValue) + ' min'
    }[preset.stopAfter] || 'until STOP';
    if (preset.mode === 'sweep') {
        return 'Sweep ' + formatDeg(preset.fromDeg) + ' to ' + formatDeg(preset.toDeg) + ' · ' + speed + ' · ' +
            formatNumber(preset.dwellMs / 1000) + ' s pause · ' + length;
    }
    return 'Spin · ' + speed + ' · ' + length;
}

// Loading fills in the speed and options; nothing moves until Start.
function loadPreset(preset) {
    send({ cmd: 'presetApply', id: preset.id });
    showTab(preset.mode);
    el('motion-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Loaded “' + preset.name + '”. ' +
        (preset.mode === 'sweep' ? 'Press Start sweep.' : 'Press CW or CCW.'));
}

// Two taps, so a stray tap doesn't delete a preset
function onDeletePreset(button, preset) {
    if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true';
        button.textContent = 'Sure?';
        button.classList.add('armed');
        setTimeout(function () {
            button.dataset.armed = 'false';
            button.textContent = 'Delete';
            button.classList.remove('armed');
        }, 4000);
        return;
    }
    send({ cmd: 'presetDelete', id: preset.id });
}

function onSavePreset(event) {
    event.preventDefault();
    var name = el('preset-name').value.trim();
    if (name === '') {
        showToast('Enter a name');
        return;
    }
    if (new TextEncoder().encode(name).length > 63) {
        showToast('That name is too long');
        return;
    }
    // Send the open tab's options first, so the preset gets what's on screen
    var options = activeTab === 'sweep' ? readSweepOptions() : readSpinOptions();
    if (options === null) {
        return;
    }
    options.cmd = activeTab === 'sweep' ? 'sweepOptions' : 'spinOptions';
    send(options);
    pendingPresetName = name;
    send({ cmd: 'presetSave', name: name, mode: activeTab });
}

// Two taps, so a stray tap doesn't drop the connection
var changeWifiTimer;
function onChangeWifi() {
    var button = el('change-wifi');
    if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true';
        button.textContent = 'Tap again to restart into setup';
        changeWifiTimer = setTimeout(function () {
            button.dataset.armed = 'false';
            button.textContent = 'Change Wi-Fi network';
        }, 4000);
        return;
    }
    clearTimeout(changeWifiTimer);
    button.dataset.armed = 'false';
    button.textContent = 'Restarting into setup…';
    send({ cmd: 'wifiSetup' });
    showToast('Restarting. Join the TURNTABLE Wi-Fi network to pick a network.');
}

function setIfIdle(input, value) {
    if (!isEditing(input)) {
        input.value = value;
    }
}

function showSpeed(rpm) {
    el('rpm-value').textContent = rpm.toFixed(1);
    el('spr-value').textContent = (60 / rpm).toFixed(1);
}

// Send speed changes while dragging, at most every 100 ms, and always the final value.
function onSpeedInput(final) {
    var slider = el('rpm');
    var rpm = parseFloat(slider.value);
    showSpeed(rpm);
    var now = Date.now();
    if (final || now - lastSpeedSent >= 100) {
        lastSpeedSent = now;
        send({ cmd: 'speed', rpm: rpm });
    }
}

// Read a field and clamp it to its allowed range, saying so if it was out of range.
// unit includes its leading space, if it needs one.
function readSetting(input, min, max, label, unit) {
    var value = readNumber(input);
    if (value === null) {
        return null;
    }
    var clamped = Math.min(Math.max(value, min), max);
    if (clamped !== value) {
        input.value = clamped;
        showToast(label + ' goes from ' + min + ' to ' + max + unit);
    }
    return clamped;
}

function readNumber(input) {
    var value = parseFloat(input.value);
    if (!isFinite(value)) {
        showToast('Enter a number');
        return null;
    }
    return value;
}

// The number next to "Run": revolutions, cycles or minutes, inside the firmware's limits.
function readStopValue(mode) {
    var input = el(mode + '-stop-value');
    var limits = state.limits;
    var what = mode === 'sweep' ? 'Sweep length' : 'Spin length';
    switch (el(mode + '-stop-after').value) {
        case 'revs':
            return readSetting(input, limits.minRevs, limits.maxRevs, what, ' revolutions');
        case 'minutes':
            return readSetting(input, limits.minMinutes, limits.maxMinutes, what, ' minutes');
        case 'cycles': {
            var cycles = readSetting(input, 1, limits.maxCycles, what, ' cycles');
            if (cycles !== null && cycles !== Math.round(cycles)) {
                cycles = Math.round(cycles);
                input.value = cycles;
            }
            return cycles;
        }
        default:
            return null;
    }
}

// The spin options on screen, or null (with a toast) if a field is off.
function readSpinOptions() {
    var stopAfter = el('spin-stop-after').value;
    if (stopAfter === 'never') {
        return { stopAfter: stopAfter };
    }
    var stopValue = readStopValue('spin');
    return stopValue === null ? null : { stopAfter: stopAfter, stopValue: stopValue };
}

function readAngle(input) {
    return readSetting(input, -state.limits.maxSweepDeg, state.limits.maxSweepDeg, 'Each angle', '°');
}

function readDwellMs() {
    var seconds = readSetting(el('sweep-dwell'), 0, state.limits.maxDwellMs / 1000, 'The pause', ' s');
    return seconds === null ? null : Math.round(seconds * 1000);
}

// The sweep options on screen, or null (with a toast) if a field is off.
function readSweepOptions() {
    var fromDeg = readAngle(el('sweep-from'));
    var toDeg = fromDeg === null ? null : readAngle(el('sweep-to'));
    var dwellMs = toDeg === null ? null : readDwellMs();
    if (dwellMs === null) {
        return null;
    }
    var options = { fromDeg: fromDeg, toDeg: toDeg, dwellMs: dwellMs, stopAfter: el('sweep-stop-after').value };
    if (options.stopAfter !== 'never') {
        options.stopValue = readStopValue('sweep');
        if (options.stopValue === null) {
            return null;
        }
    }
    return options;
}

// Send one option field when it changes, so every phone shows it and it's saved
function watchOption(id, command, field, read) {
    el(id).addEventListener('change', function () {
        if (!state) {
            return;
        }
        var value = read();
        if (value !== null) {
            var message = { cmd: command };
            message[field] = value;
            send(message);
        }
    });
}

function onLoad() {
    // Dial ticks every 15°, longer every 90°
    var ticks = el('ticks');
    for (var deg = 0; deg < 360; deg += 15) {
        var major = deg % 90 === 0;
        var rad = deg * Math.PI / 180;
        var inner = major ? 78 : 84;
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', 100 + inner * Math.sin(rad));
        line.setAttribute('y1', 100 - inner * Math.cos(rad));
        line.setAttribute('x2', 100 + 92 * Math.sin(rad));
        line.setAttribute('y2', 100 - 92 * Math.cos(rad));
        if (major) {
            line.setAttribute('class', 'major');
        }
        ticks.appendChild(line);
    }

    var savedTab = null;
    try {
        savedTab = localStorage.getItem('tab');
    } catch (e) {
        // Private browsing: start on Spin
    }
    showTab(savedTab === 'sweep' ? 'sweep' : 'spin');
    document.querySelectorAll('[data-tab]').forEach(function (button) {
        button.addEventListener('click', function () { showTab(button.dataset.tab); });
    });

    var slider = el('rpm');
    slider.addEventListener('pointerdown', function () { slider.dataset.dragging = 'true'; });
    slider.addEventListener('input', function () { onSpeedInput(false); });
    slider.addEventListener('change', function () {
        slider.dataset.dragging = 'false';
        onSpeedInput(true);
    });

    document.querySelectorAll('[data-dir]').forEach(function (button) {
        button.addEventListener('click', function () {
            // Press to toggle: the direction that's already spinning stops (with a ramp)
            var dir = button.dataset.dir;
            if (state && state.spinning && state.dir === dir && state.motion !== 'stopping') {
                send({ cmd: 'stop' });
                return;
            }
            var options = state ? readSpinOptions() : {};
            if (options !== null) {
                options.cmd = 'run';
                options.dir = dir;
                options.rpm = parseFloat(slider.value);
                send(options);
            }
        });
    });

    // Spin and sweep options
    ['spin', 'sweep'].forEach(function (mode) {
        var command = mode + 'Options';
        el(mode + '-stop-after').addEventListener('change', function () {
            showStopValue(mode);
            send({ cmd: command, stopAfter: el(mode + '-stop-after').value });
        });
        watchOption(mode + '-stop-value', command, 'stopValue', function () { return readStopValue(mode); });
    });
    watchOption('sweep-from', 'sweepOptions', 'fromDeg', function () { return readAngle(el('sweep-from')); });
    watchOption('sweep-to', 'sweepOptions', 'toDeg', function () { return readAngle(el('sweep-to')); });
    watchOption('sweep-dwell', 'sweepOptions', 'dwellMs', readDwellMs);
    el('sweep-from').addEventListener('input', showSweepSummary);
    el('sweep-to').addEventListener('input', showSweepSummary);

    el('sweep-start').addEventListener('click', function () {
        if (state && state.job && state.job.type === 'sweep') {
            send({ cmd: 'stop' });
            return;
        }
        var options = state ? readSweepOptions() : {};
        if (options !== null) {
            options.cmd = 'sweep';
            options.rpm = parseFloat(slider.value);
            send(options);
        }
    });

    el('preset-save').addEventListener('submit', onSavePreset);

    document.querySelectorAll('[data-nudge]').forEach(function (button) {
        button.addEventListener('click', function () {
            send({ cmd: 'moveBy', deg: parseFloat(button.dataset.nudge) });
        });
    });

    el('move-by').addEventListener('submit', function (event) {
        event.preventDefault();
        var deg = readNumber(el('move-by-deg'));
        if (deg !== null) {
            send({ cmd: 'moveBy', deg: deg });
        }
    });

    el('move-to').addEventListener('submit', function (event) {
        event.preventDefault();
        var deg = readNumber(el('move-to-deg'));
        if (deg !== null) {
            send({ cmd: 'moveTo', deg: deg, dir: el('move-to-dir').value });
        }
    });

    el('set-zero').addEventListener('click', function () {
        send({ cmd: 'setZero' });
    });

    document.querySelectorAll('[data-mode]').forEach(function (button) {
        button.addEventListener('click', function () {
            send({ cmd: 'settings', driveMode: button.dataset.mode });
        });
    });

    el('accel').addEventListener('change', function () {
        var value = readSetting(el('accel'), state.limits.minAccel, state.limits.maxAccel, 'Acceleration', ' RPM/s');
        if (value !== null) {
            send({ cmd: 'settings', accel: value });
        }
    });

    el('max-rpm').addEventListener('change', function () {
        var value = readSetting(el('max-rpm'), state.limits.minRpm, state.limits.maxRpm, 'Max speed', ' RPM');
        if (value !== null) {
            send({ cmd: 'settings', maxRpm: value });
        }
    });

    el('change-wifi').addEventListener('click', onChangeWifi);

    // STOP ramps down; pressing it again while stopping halts immediately.
    el('stop').addEventListener('click', function () {
        send({ cmd: state && state.motion === 'stopping' ? 'halt' : 'stop' });
    });

    initWebSocket();
}

window.addEventListener('load', onLoad);
