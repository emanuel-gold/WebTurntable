// Wi-Fi setup page, served from the setup access point (and the captive sheet that opens
// when a phone joins it). Talks to /api/wifi/* over plain HTTP.

var el = function (id) { return document.getElementById(id); };
var chosen = null;          // { ssid, secure } picked from the list, or null for "Other network…"
var scanTimer;
var statusTimer;

function show(card) {
    ['pick-card', 'join-card', 'progress-card'].forEach(function (id) {
        el(id).hidden = id !== card;
    });
    el('ap-card').hidden = card === 'progress-card';
}

function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) { return res.json(); });
}

function postForm(url, fields) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields || {}).toString()
    }).then(function (res) {
        return res.json().then(function (body) {
            if (!res.ok) {
                throw new Error(body.error || 'Request failed');
            }
            return body;
        });
    });
}

// Signal strength as 1 to 4 bars
function bars(rssi) {
    var count = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
    return '▂▄▆█'.slice(0, count);
}

function renderNetworks(networks, scanning) {
    var list = el('networks');
    list.textContent = '';
    if (networks.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = scanning ? 'Scanning…' : 'No networks found. Scan again, or use Other network.';
        list.appendChild(empty);
        return;
    }
    networks.sort(function (a, b) { return b.rssi - a.rssi; });
    networks.forEach(function (network) {
        var button = document.createElement('button');
        button.className = 'network';
        var name = document.createElement('span');
        name.className = 'network-name';
        name.textContent = network.ssid;
        var meta = document.createElement('span');
        meta.className = 'network-meta';
        meta.textContent = (network.secure ? '🔒 ' : '') + bars(network.rssi);
        meta.title = network.rssi + ' dBm';
        button.appendChild(name);
        button.appendChild(meta);
        button.addEventListener('click', function () { pick(network); });
        list.appendChild(button);
    });
}

// Ask for scan results, polling until the scan finishes
function scan() {
    clearTimeout(scanTimer);
    getJson('/api/wifi/scan').then(function (result) {
        renderNetworks(result.networks, result.scanning);
        if (result.scanning) {
            scanTimer = setTimeout(scan, 1500);
        }
    }).catch(function () {
        scanTimer = setTimeout(scan, 3000);
    });
}

function pick(network) {
    chosen = network;
    el('ssid-row').hidden = network !== null;
    el('password-row').hidden = network !== null && !network.secure;
    el('join-title').textContent = network ? 'Join ' + network.ssid : 'Other network';
    el('password').value = '';
    el('pick-error').hidden = true;
    if (network && !network.secure) {
        join();
        return;
    }
    show('join-card');
    (network ? el('password') : el('ssid')).focus();
}

function join() {
    var ssid = chosen ? chosen.ssid : el('ssid').value.trim();
    var password = el('password-row').hidden ? '' : el('password').value;
    postForm('/api/wifi/join', { ssid: ssid, password: password }).then(function () {
        showProgress('Connecting…', 'Joining ' + ssid + '. This takes up to 20 seconds.');
        pollStatus();
    }).catch(function (error) {
        showError(error.message);
    });
}

function showProgress(title, text, link) {
    el('progress-title').textContent = title;
    el('progress-text').textContent = text;
    el('open-link').hidden = !link;
    if (link) {
        el('open-link').href = link;
    }
    show('progress-card');
}

function showError(message) {
    el('pick-error').textContent = message;
    el('pick-error').hidden = false;
    show('pick-card');
}

// Follow the turntable through joining. A brief loss of contact is normal: the setup
// network can change channel to match the new network.
function pollStatus() {
    clearTimeout(statusTimer);
    getJson('/api/wifi/status').then(function (status) {
        if (status.mode === 'joining') {
            statusTimer = setTimeout(pollStatus, 1000);
        } else if (status.mode === 'joined' || status.mode === 'lan') {
            showProgress(
                'Connected to ' + status.ssid,
                'The turntable is now on your Wi-Fi at ' + status.hostname + ' (' + status.ip + '). ' +
                'This setup network closes in about 30 seconds, and your phone goes back to your Wi-Fi. ' +
                'Then open the turntable:',
                'http://' + status.hostname + '/');
        } else if (status.mode === 'setup') {
            showError(status.error || 'Couldn\'t join the network.');
            scan();
        } else {
            statusTimer = setTimeout(pollStatus, 1000);
        }
    }).catch(function () {
        statusTimer = setTimeout(pollStatus, 1500);
    });
}

function onLoad() {
    el('rescan').addEventListener('click', function () {
        renderNetworks([], true);
        scan();
    });
    el('other').addEventListener('click', function () { pick(null); });
    el('back').addEventListener('click', function () { show('pick-card'); });
    el('show-password').addEventListener('change', function () {
        el('password').type = el('show-password').checked ? 'text' : 'password';
    });
    el('join-form').addEventListener('submit', function (event) {
        event.preventDefault();
        join();
    });
    el('ap-mode').addEventListener('click', function () {
        postForm('/api/wifi/ap').then(function () {
            window.location.href = '/';
        }).catch(function (error) {
            showError(error.message);
        });
    });

    // Already set up (opened from the LAN), or mid-join after a reload?
    getJson('/api/wifi/status').then(function (status) {
        if (status.mode === 'lan') {
            showProgress('Connected to ' + status.ssid,
                'The turntable is on your Wi-Fi at ' + status.hostname + ' (' + status.ip + '). ' +
                'To pick another network, use Change Wi-Fi network in the control page\'s settings.', '/');
        } else if (status.mode === 'ap') {
            window.location.href = '/';
        } else if (status.mode === 'joining' || status.mode === 'joined') {
            pollStatus();
        } else {
            if (status.error) {
                showError(status.error);
            }
            scan();
        }
    }).catch(scan);
}

window.addEventListener('load', onLoad);
