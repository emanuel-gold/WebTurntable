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

var TABS = ['spin', 'sweep', 'photo', 'video'];
var START_HINTS = {
    spin: 'Press CW or CCW.',
    sweep: 'Press Start sweep.',
    photo: 'Press Start photos.',
    video: 'Press Start video.'
};

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
    var motionText = s.job ? { spin: 'Spinning', sweep: 'Sweeping', photo: 'Photos', video: 'Video' }[s.job.type] : {
        idle: 'Stopped',
        running: 'Spinning',
        moving: 'Moving',
        stopping: 'Stopping'
    }[s.motion] || s.motion;
    if (s.motion !== 'idle') {
        motionText += ' · ' + speed.toFixed(1) + ' RPM ' + (s.speed >= 0 ? 'CW' : 'CCW');
    } else if (s.job && (s.job.type === 'spin' || s.job.type === 'sweep')) {
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

    // Photo and video options
    setIfIdle(el('photo-shots'), s.photo.shots);
    setIfIdle(el('photo-step'), formatNumber(s.photo.stepDeg));
    setIfIdle(el('photo-settle'), formatNumber(s.photo.settleMs / 1000));
    setIfIdle(el('photo-after'), formatNumber(s.photo.afterMs / 1000));
    setIfIdle(el('photo-delay'), formatNumber(s.photo.delayMs / 1000));
    setCheckedIfIdle(el('photo-return'), s.photo.returnToStart);
    setCheckedIfIdle(el('photo-press'), s.photo.pressShutter);
    setSegment('[data-photo-dir]', 'photoDir', s.photo.dir);
    setIfIdle(el('video-motion'), s.video.motion);
    setSegment('[data-video-dir]', 'videoDir', s.video.dir);
    setIfIdle(el('video-lead-in'), formatNumber(s.video.leadInMs / 1000));
    setIfIdle(el('video-lead-out'), formatNumber(s.video.leadOutMs / 1000));
    setIfIdle(el('video-delay'), formatNumber(s.video.delayMs / 1000));
    el('video-dir-row').hidden = el('video-motion').value !== 'spin';
    showPhotoSummary();
    showCaptureEstimates();
    renderCaptureButtons(s.job);
    renderShutter(s.shutter);

    // Settings
    setSegment('[data-mode]', 'mode', s.settings.driveMode);
    setIfIdle(el('accel'), s.settings.accel);
    setIfIdle(el('max-rpm'), s.settings.maxRpm);
    el('accel').min = s.limits.minAccel;
    el('accel').max = s.limits.maxAccel;
    el('max-rpm').min = s.limits.minRpm;
    el('max-rpm').max = s.limits.maxRpm;

    el('stop').textContent = s.motion === 'stopping' ? 'HALT NOW' : 'STOP';

    renderWifi(s.wifi);
}

// Light up the button of a segmented control whose data-<key> matches value.
function setSegment(selector, key, value) {
    document.querySelectorAll(selector).forEach(function (button) {
        var active = button.dataset[key] === value;
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', active);
    });
}

// What's left of the running job, for the line under the angle.
function jobText(job) {
    if (!job) {
        return '';
    }
    if (job.type === 'photo' || job.type === 'video') {
        return captureText(job);
    }
    return motionJobText(job);
}

// What's left of a spin or sweep, alone or inside a video.
function motionJobText(job) {
    var parts = [];
    if (job.cycle !== undefined) {
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

function captureText(job) {
    if (job.paused) {
        return job.needsShutter ? 'Paused: no phone on the shutter' : 'Paused';
    }
    if (job.stage === 'delay') {
        return (job.type === 'video' ? 'Recording starts in ' : 'Starts in ') + job.startsIn + ' s';
    }
    if (job.type === 'photo') {
        if (job.stage === 'return') {
            return 'Returning to the start';
        }
        return 'Shot ' + job.shot + ' of ' + job.shots + ' · about ' +
            formatTime(Math.round(photoSeconds(state.photo, job.shot))) + ' left';
    }
    if (job.stage === 'leadIn' || job.stage === 'leadOut') {
        return 'Recording · ' + (job.stage === 'leadIn' ? 'lead-in' : 'lead-out');
    }
    var motion = motionJobText(job);
    return 'Recording' + (motion ? ' · ' + motion : '');
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
    TABS.forEach(function (name) {
        el('panel-' + name).hidden = name !== tab;
    });
    el('preset-save-button').textContent = 'Save ' + tab;
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

function showPhotoSummary() {
    var shots = parseInt(el('photo-shots').value, 10);
    var step = parseFloat(el('photo-step').value);
    var text;
    if (!(shots >= 1) || !(step > 0)) {
        text = 'Enter the shots and the step.';
    } else if (Math.abs(shots * step - 360) < 0.01) {
        text = shots + ' shots over one full turn.';
    } else {
        text = shots + ' shots ' + formatDeg(step) + ' apart, covering ' + formatDeg((shots - 1) * step) + '.';
    }
    el('photo-summary').textContent = text;
}

// "3 rev", "4 cycles", "2 min" or "until STOP", for spin or sweep options.
function lengthText(options) {
    return {
        revs: formatNumber(options.stopValue) + ' rev',
        cycles: formatNumber(options.stopValue) + (options.stopValue === 1 ? ' cycle' : ' cycles'),
        minutes: formatNumber(options.stopValue) + ' min'
    }[options.stopAfter] || 'until STOP';
}

// Seconds for a move, following the motion engine's ramp: speed up, cruise, slow down.
function moveSeconds(deg, rpm, accel) {
    var speed = rpm * 6;        // Degrees per second
    var rate = accel * 6;       // Degrees per second, per second
    if (deg <= 0) {
        return 0;
    }
    return deg >= speed * speed / rate ? deg / speed + speed / rate : 2 * Math.sqrt(deg / rate);
}

// Seconds a photo capture takes from shot `from` (counting from 1) to the end, without the start delay.
function photoSeconds(photo, from) {
    var rpm = state.rpm;
    var accel = state.settings.accel;
    var shotsLeft = photo.shots - from + 1;
    var seconds = shotsLeft * (photo.settleMs + photo.afterMs) / 1000 +
        Math.max(shotsLeft - 1, 0) * moveSeconds(photo.stepDeg, rpm, accel);
    if (photo.returnToStart) {
        var turned = ((photo.shots - 1) * photo.stepDeg) % 360;
        seconds += moveSeconds(Math.min(turned, 360 - turned), rpm, accel);
    }
    return seconds;
}

// Seconds of video, lead-in to lead-out, or null if the motion runs until STOP.
function videoSeconds(video) {
    var rpm = state.rpm;
    var accel = state.settings.accel;
    var motion;
    if (video.motion === 'sweep') {
        var sweep = state.sweep;
        var leg = moveSeconds(Math.abs(sweep.toDeg - sweep.fromDeg), rpm, accel) + sweep.dwellMs / 1000;
        if (sweep.stopAfter === 'never') {
            return null;
        }
        motion = sweep.stopAfter === 'minutes' ? sweep.stopValue * 60 + leg : sweep.stopValue * 2 * leg;
    } else {
        var spin = state.spin;
        if (spin.stopAfter === 'never') {
            return null;
        }
        motion = spin.stopAfter === 'minutes' ? spin.stopValue * 60 + rpm / accel
            : moveSeconds(spin.stopValue * 360, rpm, accel);
    }
    return (video.leadInMs + video.leadOutMs) / 1000 + motion;
}

function showCaptureEstimates() {
    var photo = state.photo;
    var delay = formatNumber(photo.delayMs / 1000);
    el('photo-estimate').textContent = 'About ' + formatTime(Math.round(photoSeconds(photo, 1))) +
        ' at ' + formatNumber(state.rpm) + ' RPM, after the ' + delay + ' s delay.';

    var video = state.video;
    var options = video.motion === 'sweep' ? state.sweep : state.spin;
    var motion = video.motion === 'sweep'
        ? 'Sweeps ' + formatDeg(options.fromDeg) + ' to ' + formatDeg(options.toDeg)
        : 'Spins ' + video.dir.toUpperCase();
    el('video-summary').textContent = motion + ', ' + lengthText(options) + ', at ' + formatNumber(state.rpm) +
        ' RPM: set on the ' + (video.motion === 'sweep' ? 'Sweep' : 'Spin') + ' tab.';
    var seconds = videoSeconds(video);
    el('video-estimate').textContent = seconds === null
        ? 'Records until you press STOP, which also stops the recording.'
        : 'About ' + formatTime(Math.round(seconds)) + ' of video, after the ' +
            formatNumber(video.delayMs / 1000) + ' s delay.';
}

// The Start buttons pause, resume or stop the capture that's running.
function renderCaptureButtons(job) {
    var photo = job !== null && job.type === 'photo';
    el('photo-start').textContent = photo ? (job.paused ? 'Resume' : 'Pause') : 'Start photos';
    el('photo-start').classList.toggle('active', photo);
    var video = job !== null && job.type === 'video';
    el('video-start').textContent = video ? (job.paused ? 'Resume' : 'Stop video') : 'Start video';
    el('video-start').classList.toggle('active', video);
}

function renderShutter(shutter) {
    var text = !shutter.enabled ? 'Off'
        : shutter.ready ? 'Connected'
        : shutter.connected ? 'Pairing…'
        : 'No phone';
    document.querySelectorAll('.shutter-status').forEach(function (status) { status.textContent = text; });
    document.querySelectorAll('.shutter-test').forEach(function (button) { button.disabled = !shutter.ready; });

    var pill = el('shutter-pill');
    pill.hidden = !shutter.enabled;
    pill.textContent = shutter.ready ? 'Shutter' : 'No shutter';
    pill.classList.toggle('off', !shutter.ready);

    setSegment('[data-shutter-enabled]', 'shutterEnabled', String(shutter.enabled));
    setIfIdle(el('shutter-key'), shutter.key);
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
    switch (preset.mode) {
        case 'sweep':
            return 'Sweep ' + formatDeg(preset.fromDeg) + ' to ' + formatDeg(preset.toDeg) + ' · ' + speed + ' · ' +
                formatNumber(preset.dwellMs / 1000) + ' s pause · ' + lengthText(preset);
        case 'photo':
            return 'Photo · ' + preset.shots + ' shots, ' + formatDeg(preset.stepDeg) + ' apart · ' + speed;
        case 'video':
            return 'Video · ' + (preset.motion === 'sweep'
                ? 'sweep ' + formatDeg(preset.sweep.fromDeg) + ' to ' + formatDeg(preset.sweep.toDeg) + ', ' +
                    lengthText(preset.sweep)
                : 'spin ' + preset.dir.toUpperCase() + ', ' + lengthText(preset.spin)) + ' · ' + speed;
        default:
            return 'Spin · ' + speed + ' · ' + lengthText(preset);
    }
}

// Loading fills in the speed and options; nothing moves until Start.
function loadPreset(preset) {
    send({ cmd: 'presetApply', id: preset.id });
    showTab(preset.mode);
    el('motion-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Loaded “' + preset.name + '”. ' + START_HINTS[preset.mode]);
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

// Send a tab's options as on screen, so a preset gets what's shown. False if a field is off.
function sendOptions(tab) {
    var readers = { spin: readSpinOptions, sweep: readSweepOptions, photo: readPhotoOptions, video: readVideoOptions };
    var options = readers[tab]();
    if (options === null) {
        return false;
    }
    options.cmd = tab + 'Options';
    send(options);
    return true;
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
    // A video preset keeps the spin or sweep it records, too
    if (!sendOptions(activeTab) || (activeTab === 'video' && !sendOptions(el('video-motion').value))) {
        return;
    }
    pendingPresetName = name;
    send({ cmd: 'presetSave', name: name, mode: activeTab });
}

// Two taps for a button that does something drastic. Returns true on the second tap.
function confirmTap(button, armedText, idleText) {
    if (button.dataset.armed === 'true') {
        clearTimeout(button.armTimer);
        button.dataset.armed = 'false';
        return true;
    }
    button.dataset.armed = 'true';
    button.textContent = armedText;
    button.armTimer = setTimeout(function () {
        button.dataset.armed = 'false';
        button.textContent = idleText;
    }, 4000);
    return false;
}

// Two taps, so a stray tap doesn't drop the connection
function onChangeWifi() {
    var button = el('change-wifi');
    if (!confirmTap(button, 'Tap again to restart into setup', 'Change Wi-Fi network')) {
        return;
    }
    button.textContent = 'Restarting into setup…';
    send({ cmd: 'wifiSetup' });
    showToast('Restarting. Join the TURNTABLE Wi-Fi network to pick a network.');
}

function onForgetPhones() {
    var button = el('shutter-forget');
    if (!confirmTap(button, 'Tap again to forget them', 'Forget paired phones')) {
        return;
    }
    button.textContent = 'Forget paired phones';
    send({ cmd: 'shutterForget' });
    showToast('Forgotten. On the phone, also choose Forget This Device under Turntable Shutter.');
}

function setIfIdle(input, value) {
    if (!isEditing(input)) {
        input.value = value;
    }
}

function setCheckedIfIdle(input, checked) {
    if (!isEditing(input)) {
        input.checked = checked;
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

// A whole number inside the limits, or null (with a toast).
function readWhole(input, min, max, label, unit) {
    var value = readSetting(input, min, max, label, unit);
    if (value !== null && value !== Math.round(value)) {
        value = Math.round(value);
        input.value = value;
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
        case 'cycles':
            return readWhole(input, 1, limits.maxCycles, what, ' cycles');
        default:
            return null;
    }
}

// A wait in seconds on screen, as milliseconds inside the firmware's limit.
function readWaitMs(id, label) {
    var seconds = readSetting(el(id), 0, state.limits.maxWaitMs / 1000, label, ' s');
    return seconds === null ? null : Math.round(seconds * 1000);
}

// Read fields in order, stopping at the first that's off. reads maps each key to a reader.
function readAll(reads) {
    var options = {};
    var keys = Object.keys(reads);
    for (var i = 0; i < keys.length; i++) {
        var value = reads[keys[i]]();
        if (value === null) {
            return null;
        }
        options[keys[i]] = value;
    }
    return options;
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
    var options = readAll({
        fromDeg: function () { return readAngle(el('sweep-from')); },
        toDeg: function () { return readAngle(el('sweep-to')); },
        dwellMs: readDwellMs
    });
    if (options === null) {
        return null;
    }
    options.stopAfter = el('sweep-stop-after').value;
    if (options.stopAfter !== 'never') {
        options.stopValue = readStopValue('sweep');
        if (options.stopValue === null) {
            return null;
        }
    }
    return options;
}

function readShots() {
    return readWhole(el('photo-shots'), 1, state.limits.maxShots, 'The number of shots', '');
}

function readStep() {
    return readSetting(el('photo-step'), state.limits.minStepDeg, state.limits.maxStepDeg, 'The step', '°');
}

// The photo options on screen, or null (with a toast) if a field is off.
function readPhotoOptions() {
    var options = readAll({
        shots: readShots,
        stepDeg: readStep,
        settleMs: function () { return readWaitMs('photo-settle', 'The settle time'); },
        afterMs: function () { return readWaitMs('photo-after', 'The wait after a shot'); },
        delayMs: function () { return readWaitMs('photo-delay', 'The delay'); }
    });
    if (options !== null) {
        options.dir = state.photo.dir;
        options.returnToStart = el('photo-return').checked;
        options.pressShutter = el('photo-press').checked;
    }
    return options;
}

// The video options on screen, or null (with a toast) if a field is off.
function readVideoOptions() {
    var options = readAll({
        leadInMs: function () { return readWaitMs('video-lead-in', 'The lead-in'); },
        leadOutMs: function () { return readWaitMs('video-lead-out', 'The lead-out'); },
        delayMs: function () { return readWaitMs('video-delay', 'The delay'); }
    });
    if (options !== null) {
        options.motion = el('video-motion').value;
        options.dir = state.video.dir;
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

// Start a capture with the options on screen, or pause, resume or stop the one that's running.
function onCaptureButton(type, read) {
    var job = state && state.job;
    if (job && job.type === type) {
        if (job.paused) {
            send({ cmd: 'captureResume' });
        } else {
            send({ cmd: type === 'photo' ? 'capturePause' : 'stop' });
        }
        return;
    }
    var options = state ? read() : {};
    if (options !== null) {
        options.cmd = type;
        options.rpm = parseFloat(el('rpm').value);
        send(options);
    }
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
    showTab(TABS.indexOf(savedTab) >= 0 ? savedTab : 'spin');
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

    // Photo options. Changing the shots fills in the step for one full turn.
    el('photo-shots').addEventListener('change', function () {
        var shots = state ? readShots() : null;
        if (shots !== null) {
            var step = Math.round(36000 / shots) / 100;
            el('photo-step').value = step;
            showPhotoSummary();
            send({ cmd: 'photoOptions', shots: shots, stepDeg: step });
        }
    });
    watchOption('photo-step', 'photoOptions', 'stepDeg', readStep);
    watchOption('photo-settle', 'photoOptions', 'settleMs', function () { return readWaitMs('photo-settle', 'The settle time'); });
    watchOption('photo-after', 'photoOptions', 'afterMs', function () { return readWaitMs('photo-after', 'The wait after a shot'); });
    watchOption('photo-delay', 'photoOptions', 'delayMs', function () { return readWaitMs('photo-delay', 'The delay'); });
    el('photo-shots').addEventListener('input', showPhotoSummary);
    el('photo-step').addEventListener('input', showPhotoSummary);
    ['photo-return', 'photo-press'].forEach(function (id) {
        el(id).addEventListener('change', function () {
            var message = { cmd: 'photoOptions' };
            message[id === 'photo-return' ? 'returnToStart' : 'pressShutter'] = el(id).checked;
            send(message);
        });
    });
    document.querySelectorAll('[data-photo-dir]').forEach(function (button) {
        button.addEventListener('click', function () {
            send({ cmd: 'photoOptions', dir: button.dataset.photoDir });
        });
    });
    el('photo-start').addEventListener('click', function () { onCaptureButton('photo', readPhotoOptions); });

    // Video options
    el('video-motion').addEventListener('change', function () {
        el('video-dir-row').hidden = el('video-motion').value !== 'spin';
        send({ cmd: 'videoOptions', motion: el('video-motion').value });
    });
    document.querySelectorAll('[data-video-dir]').forEach(function (button) {
        button.addEventListener('click', function () {
            send({ cmd: 'videoOptions', dir: button.dataset.videoDir });
        });
    });
    watchOption('video-lead-in', 'videoOptions', 'leadInMs', function () { return readWaitMs('video-lead-in', 'The lead-in'); });
    watchOption('video-lead-out', 'videoOptions', 'leadOutMs', function () { return readWaitMs('video-lead-out', 'The lead-out'); });
    watchOption('video-delay', 'videoOptions', 'delayMs', function () { return readWaitMs('video-delay', 'The delay'); });
    el('video-start').addEventListener('click', function () { onCaptureButton('video', readVideoOptions); });

    // Bluetooth shutter
    document.querySelectorAll('.shutter-test').forEach(function (button) {
        button.addEventListener('click', function () { send({ cmd: 'shutterTest' }); });
    });
    document.querySelectorAll('[data-shutter-enabled]').forEach(function (button) {
        button.addEventListener('click', function () {
            send({ cmd: 'shutter', enabled: button.dataset.shutterEnabled === 'true' });
        });
    });
    el('shutter-key').addEventListener('change', function () {
        send({ cmd: 'shutter', key: el('shutter-key').value });
    });
    el('shutter-forget').addEventListener('click', onForgetPhones);

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
