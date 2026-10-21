// Web UI for the turntable. Talks the v2 protocol over /ws (see docs/FIRMWARE.md):
// sends {"cmd": ...} commands and renders every {"type":"state"} the device broadcasts.

var gateway = `ws://${window.location.host}/ws`;
var websocket;
var state = null;
var pointerTurns = 0;       // Unwrapped pointer rotation, so it never spins the long way round
var lastSpeedSent = 0;
var toastTimer;

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
    var motionText = {
        idle: 'Stopped',
        running: 'Spinning',
        moving: 'Moving',
        stopping: 'Stopping'
    }[s.motion] || s.motion;
    if (s.motion !== 'idle') {
        motionText += ' · ' + speed.toFixed(1) + ' RPM ' + (s.speed >= 0 ? 'CW' : 'CCW');
    }
    el('motion').textContent = motionText;

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

// Read a settings field and clamp it to its allowed range, saying so if it was out of range.
function readSetting(input, min, max, label, unit) {
    var value = readNumber(input);
    if (value === null) {
        return null;
    }
    var clamped = Math.min(Math.max(value, min), max);
    if (clamped !== value) {
        input.value = clamped;
        showToast(label + ' goes from ' + min + ' to ' + max + ' ' + unit);
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
            } else {
                send({ cmd: 'run', dir: dir, rpm: parseFloat(slider.value) });
            }
        });
    });

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
        var value = readSetting(el('accel'), state.limits.minAccel, state.limits.maxAccel, 'Acceleration', 'RPM/s');
        if (value !== null) {
            send({ cmd: 'settings', accel: value });
        }
    });

    el('max-rpm').addEventListener('change', function () {
        var value = readSetting(el('max-rpm'), state.limits.minRpm, state.limits.maxRpm, 'Max speed', 'RPM');
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
