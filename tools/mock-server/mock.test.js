// Tests for the mock server. Run with `node --test tools/mock-server/mock.test.js`
// (Node 22.4+, which has a built-in WebSocket client).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startMockServer } from './mock.js';

let mock;
let baseUrl;

before(async () => {
    mock = await startMockServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${mock.port}`;
});

after(() => mock.close());

// Open a WebSocket and queue its messages, so none are missed between awaits.
// Presets messages get their own queue, so tests that read states and errors don't trip on them.
async function connect(server = mock) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const queues = { main: [], presets: [] };
    const waiters = { main: [], presets: [] };
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const kind = msg.type === 'presets' ? 'presets' : 'main';
        const waiter = waiters[kind].shift();
        waiter ? waiter(msg) : queues[kind].push(msg);
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    const take = (kind) => queues[kind].length > 0
        ? Promise.resolve(queues[kind].shift())
        : new Promise((resolve) => waiters[kind].push(resolve));
    const next = () => take('main');
    const nextPresets = () => take('presets');
    const send = (obj) => ws.send(JSON.stringify(obj));

    // Read messages until one matches, failing after timeoutMs.
    async function waitFor(predicate, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            assert.ok(remaining > 0, 'timed out waiting for a matching message');
            const msg = await Promise.race([
                next(),
                new Promise((resolve) => setTimeout(resolve, remaining, null)),
            ]);
            if (msg && predicate(msg)) {
                return msg;
            }
        }
    }
    return { ws, next, nextPresets, send, waitFor };
}

// Run a protocol test against its own mock, so device state doesn't leak between tests.
async function withDevice(body, options = {}) {
    const server = await startMockServer({ port: 0, ...options });
    const client = await connect(server);
    try {
        await body(client, server);
    } finally {
        client.ws.close();
        await server.close();
    }
}

const isState = (msg) => msg.type === 'state';

// Raw request, so the path is sent as-is (fetch would normalize "..").
function rawGet(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: mock.port, path }, (res) => {
            res.resume();
            resolve(res.statusCode);
        }).on('error', reject);
    });
}

test('serves the web UI', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>Turntable<\/title>/);

    const css = await fetch(`${baseUrl}/style.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
});

test('does not serve files outside the data folder', async () => {
    assert.equal(await rawGet('/..%2fserver.cpp'), 403);
    assert.equal(await rawGet('/..%2f..%2f..%2fCLAUDE.md'), 403);
});

test('sends the full state and the presets on connect', () => withDevice(async ({ next, nextPresets }) => {
    const msg = await next();
    assert.equal(msg.type, 'state');
    assert.equal(msg.motion, 'idle');
    assert.equal(msg.angle, 0);
    assert.equal(msg.rpm, 5);
    assert.equal(msg.dir, 'cw');
    assert.equal(msg.spinning, false);
    assert.equal(msg.job, null);
    assert.deepEqual(msg.spin, { stopAfter: 'never', stopValue: 1 });
    assert.deepEqual(msg.sweep, { fromDeg: -30, toDeg: 30, dwellMs: 500, stopAfter: 'never', stopValue: 4 });
    assert.deepEqual(msg.settings, { driveMode: 'half', maxRpm: 20, accel: 20 });
    assert.deepEqual(msg.limits, {
        minRpm: 0.5, maxRpm: 20, minAccel: 1, maxAccel: 200,
        minRevs: 0.1, maxRevs: 1000, minMinutes: 0.1, maxMinutes: 600,
        maxCycles: 1000, maxSweepDeg: 3600, maxDwellMs: 60000,
    });
    assert.deepEqual(await nextPresets(), { type: 'presets', presets: [] });
}));

test('broadcasts each change to every client', () => withDevice(async (a, server) => {
    const b = await connect(server);
    await a.next();
    await b.next();

    a.send({ cmd: 'speed', rpm: 8 });
    assert.equal((await a.waitFor(isState)).rpm, 8);
    assert.equal((await b.waitFor(isState)).rpm, 8);
    b.ws.close();
}));

test('rejects bad commands with an error to the sender only', () => withDevice(async ({ next, send, ws }) => {
    await next();
    ws.send('not json');
    assert.deepEqual(await next(), { type: 'error', msg: 'malformed JSON' });
    send({ cmd: 'bogus' });
    assert.deepEqual(await next(), { type: 'error', msg: 'unknown command' });
    send({ type: 'stepping_speed', content: 50 });
    assert.deepEqual(await next(), { type: 'error', msg: 'unknown command' });
    send({ cmd: 'run' });
    assert.deepEqual(await next(), { type: 'error', msg: 'run needs dir cw or ccw' });
    send({ cmd: 'speed', rpm: '50' });
    assert.deepEqual(await next(), { type: 'error', msg: 'speed needs a number rpm' });
    send({ cmd: 'moveTo', deg: 10, dir: 'sideways' });
    assert.deepEqual(await next(), { type: 'error', msg: 'dir must be shortest, cw or ccw' });
    send({ cmd: 'spinOptions', stopAfter: 'cycles' });
    assert.deepEqual(await next(), { type: 'error', msg: 'stopAfter must be never, revs or minutes' });
    send({ cmd: 'sweepOptions', stopAfter: 'revs' });
    assert.deepEqual(await next(), { type: 'error', msg: 'stopAfter must be never, cycles or minutes' });
    send({ cmd: 'sweepOptions', fromDeg: 'left' });
    assert.deepEqual(await next(), { type: 'error', msg: 'fromDeg, toDeg and dwellMs must be numbers' });
    send({ cmd: 'sweep', stopValue: '4' });
    assert.deepEqual(await next(), { type: 'error', msg: 'stopValue must be a number' });
    send({ cmd: 'presetSave', name: '', mode: 'spin' });
    assert.deepEqual(await next(), { type: 'error', msg: 'preset needs a name, up to 63 bytes' });
    send({ cmd: 'presetSave', name: 'x'.repeat(64), mode: 'spin' });
    assert.deepEqual(await next(), { type: 'error', msg: 'preset needs a name, up to 63 bytes' });
    send({ cmd: 'presetSave', name: 'Capture', mode: 'capture' });
    assert.deepEqual(await next(), { type: 'error', msg: 'presetSave needs mode spin or sweep' });
    send({ cmd: 'presetApply', id: 10 });
    assert.deepEqual(await next(), { type: 'error', msg: 'no preset with that id' });
}));

test('clamps speed to the limits and max speed', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'speed', rpm: 99 });
    assert.equal((await waitFor(isState)).rpm, 20);
    send({ cmd: 'speed', rpm: 0 });
    assert.equal((await waitFor(isState)).rpm, 0.5);

    // Lowering the max speed pulls the speed setting down with it.
    send({ cmd: 'speed', rpm: 12 });
    await waitFor(isState);
    send({ cmd: 'settings', maxRpm: 10, accel: 500 });
    const msg = await waitFor(isState);
    assert.equal(msg.rpm, 10);
    assert.deepEqual(msg.settings, { driveMode: 'half', maxRpm: 10, accel: 200 });
}));

test('moves by an angle and stops on it', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 15 });
    send({ cmd: 'moveBy', deg: 90 });
    const moving = await waitFor((m) => isState(m) && m.motion === 'moving');
    assert.ok(moving.angle >= 0);
    const done = await waitFor((m) => isState(m) && m.motion === 'idle');
    assert.equal(done.angle, 90);
    assert.equal(done.speed, 0);

    // Quick presses add up from the unfinished target.
    send({ cmd: 'moveBy', deg: 15 });
    send({ cmd: 'moveBy', deg: 15 });
    send({ cmd: 'moveBy', deg: 15 });
    await waitFor((m) => isState(m) && m.motion === 'moving');
    assert.equal((await waitFor((m) => isState(m) && m.motion === 'idle')).angle, 135);

    // A full turn of 15 deg nudges lands back on the same angle, with no rounding drift.
    for (let i = 0; i < 24; i++) {
        send({ cmd: 'moveBy', deg: 15 });
    }
    await waitFor((m) => isState(m) && m.motion === 'moving');
    assert.equal((await waitFor((m) => isState(m) && m.motion === 'idle', 10000)).angle, 135);
}));

test('goes to an angle the shortest way or a chosen way', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 15 });
    send({ cmd: 'moveTo', deg: 300 });  // shortest from 0 is 60 deg counter-clockwise
    const moving = await waitFor((m) => isState(m) && m.motion === 'moving' && m.speed !== 0);
    assert.ok(moving.speed < 0, 'shortest way to 300 deg is counter-clockwise');
    assert.equal((await waitFor((m) => isState(m) && m.motion === 'idle')).angle, 300);

    send({ cmd: 'moveTo', deg: 290, dir: 'cw' });  // 350 deg the long way round
    const cw = await waitFor((m) => isState(m) && m.motion === 'moving' && m.speed !== 0);
    assert.ok(cw.speed > 0);
    assert.equal((await waitFor((m) => isState(m) && m.motion === 'idle', 10000)).angle, 290);
}));

test('spins, ramps up, and stops', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'run', dir: 'ccw', rpm: 10 });
    const running = await waitFor((m) => isState(m) && m.motion === 'running');
    assert.equal(running.spinning, true);
    assert.equal(running.dir, 'ccw');
    await waitFor((m) => isState(m) && m.speed === -10);

    send({ cmd: 'stop' });
    const stopping = await waitFor((m) => isState(m) && m.motion !== 'running');
    assert.equal(stopping.spinning, false);
    await waitFor((m) => isState(m) && m.motion === 'idle');
}));

test('sets zero at the current angle', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 15 });
    send({ cmd: 'moveBy', deg: 45 });
    await waitFor((m) => isState(m) && m.motion === 'idle' && m.angle === 45);
    send({ cmd: 'setZero' });
    assert.equal((await waitFor(isState)).angle, 0);
}));

test('changes speed during a move', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 2 });
    send({ cmd: 'moveBy', deg: 360 });
    await waitFor((m) => isState(m) && m.speed === 2);
    send({ cmd: 'speed', rpm: 15 });
    await waitFor((m) => isState(m) && m.speed === 15);
    assert.equal((await waitFor((m) => isState(m) && m.motion === 'idle', 10000)).angle, 0);
}));

test('spins a set number of revolutions and lands back on its start angle', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 20 });
    send({ cmd: 'moveBy', deg: 45 });
    await waitFor((m) => isState(m) && m.motion === 'idle' && m.angle === 45);

    send({ cmd: 'spinOptions', stopAfter: 'revs', stopValue: 1 });
    send({ cmd: 'run', dir: 'ccw' });
    const running = await waitFor((m) => isState(m) && m.job?.type === 'spin' && m.speed < 0);
    assert.equal(running.spinning, true);
    assert.ok(running.job.revsLeft > 0 && running.job.revsLeft <= 1);
    const done = await waitFor((m) => isState(m) && m.motion === 'idle', 10000);
    assert.equal(done.angle, 45);
    assert.equal(done.job, null);
    assert.equal(done.spinning, false);
}));

test('spins for a set time, then ramps down', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    const started = Date.now();
    send({ cmd: 'run', dir: 'cw', rpm: 10, stopAfter: 'minutes', stopValue: 0.1 });
    const running = await waitFor((m) => isState(m) && m.motion === 'running');
    assert.deepEqual(running.spin, { stopAfter: 'minutes', stopValue: 0.1 });
    assert.equal(running.job.type, 'spin');
    assert.ok(running.job.secondsLeft >= 5 && running.job.secondsLeft <= 6);
    const ended = await waitFor((m) => isState(m) && m.job === null, 10000);
    assert.ok(Date.now() - started >= 5900, 'stopped too early');
    assert.notEqual(ended.motion, 'running');
    await waitFor((m) => isState(m) && m.motion === 'idle');
}));

test('sweeps between two angles for a set number of cycles', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 20 });
    send({ cmd: 'sweep', fromDeg: -30, toDeg: 30, dwellMs: 300, stopAfter: 'cycles', stopValue: 2 });

    // It goes to From first, the short way: counter-clockwise from 0 to 330.
    const first = await waitFor((m) => isState(m) && m.job?.type === 'sweep' && m.speed !== 0);
    assert.ok(first.speed < 0);
    assert.deepEqual(first.job, { type: 'sweep', cycle: 1, cycles: 2 });
    await waitFor((m) => isState(m) && m.motion === 'idle' && m.angle === 330 && m.job?.cycle === 1);
    await waitFor((m) => isState(m) && m.motion === 'idle' && m.angle === 30 && m.job?.cycle === 1);
    await waitFor((m) => isState(m) && m.job?.cycle === 2, 10000);
    await waitFor((m) => isState(m) && m.motion === 'idle' && m.angle === 30 && m.job?.cycle === 2, 10000);

    // A cycle is From to To and back, so it ends on From.
    const done = await waitFor((m) => isState(m) && m.job === null, 10000);
    assert.equal(done.motion, 'idle');
    assert.equal(done.angle, 330);
}));

test('a timed sweep stops at the next end once time is up', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 20 });
    send({ cmd: 'sweepOptions', fromDeg: -30, toDeg: 30, dwellMs: 200, stopAfter: 'minutes', stopValue: 0.1 });
    const started = Date.now();
    send({ cmd: 'sweep' });
    const running = await waitFor((m) => isState(m) && m.job?.type === 'sweep');
    assert.ok(running.job.secondsLeft >= 5 && running.job.secondsLeft <= 6);
    const done = await waitFor((m) => isState(m) && m.job === null, 12000);
    assert.ok(Date.now() - started >= 5900, 'stopped too early');
    assert.equal(done.motion, 'idle');
    assert.ok([330, 30].includes(done.angle), `stopped at ${done.angle}, not an end`);
}));

test('refuses a sweep whose ends are the same angle', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'sweep', fromDeg: 10, toDeg: 10 });
    assert.deepEqual(await waitFor((m) => m.type === 'error'), { type: 'error', msg: 'From and To must be different angles' });
    const state = await waitFor(isState);
    assert.equal(state.job, null);
    assert.equal(state.motion, 'idle');
}));

test('set zero during a sweep keeps it on the same ends', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'settings', accel: 200 });
    send({ cmd: 'speed', rpm: 20 });
    send({ cmd: 'sweep', fromDeg: -30, toDeg: 30, dwellMs: 1000, stopAfter: 'cycles', stopValue: 1 });
    await waitFor((m) => isState(m) && m.job?.type === 'sweep' && m.motion === 'idle' && m.angle === 30, 10000);

    // Zero moves to To, so From is now 60 degrees counter-clockwise of it. The ends sit on
    // half-steps: -30 and 30 are -341 and 341, so From is 682 half-steps (59.94 deg) back.
    send({ cmd: 'setZero' });
    const done = await waitFor((m) => isState(m) && m.job === null, 10000);
    assert.equal(done.angle, 300.1);
}));

test('saves, loads and deletes presets', () => withDevice(async ({ next, nextPresets, send, waitFor }) => {
    await next();
    assert.deepEqual((await nextPresets()).presets, []);

    send({ cmd: 'speed', rpm: 3 });
    send({ cmd: 'spinOptions', stopAfter: 'revs', stopValue: 2 });
    send({ cmd: 'presetSave', name: 'Slow two', mode: 'spin' });
    assert.deepEqual((await nextPresets()).presets, [
        { id: 0, name: 'Slow two', mode: 'spin', rpm: 3, stopAfter: 'revs', stopValue: 2 },
    ]);

    send({ cmd: 'speed', rpm: 8 });
    send({ cmd: 'sweepOptions', fromDeg: -45, toDeg: 45, dwellMs: 1000, stopAfter: 'cycles', stopValue: 3 });
    send({ cmd: 'presetSave', name: 'Wide sweep', mode: 'sweep' });
    assert.deepEqual((await nextPresets()).presets[1], {
        id: 1, name: 'Wide sweep', mode: 'sweep', rpm: 8,
        fromDeg: -45, toDeg: 45, dwellMs: 1000, stopAfter: 'cycles', stopValue: 3,
    });

    // Loading sets the speed and that mode's options, and starts nothing.
    send({ cmd: 'speed', rpm: 12 });
    send({ cmd: 'spinOptions', stopAfter: 'never' });
    send({ cmd: 'sweepOptions', fromDeg: 0, toDeg: 90 });
    send({ cmd: 'presetApply', id: 0 });
    const loaded = await waitFor((m) => isState(m) && m.rpm === 3 && m.sweep.toDeg === 90);
    assert.deepEqual(loaded.spin, { stopAfter: 'revs', stopValue: 2 });
    assert.equal(loaded.sweep.fromDeg, 0, 'a spin preset leaves the sweep options alone');
    assert.equal(loaded.motion, 'idle');
    assert.equal(loaded.job, null);

    send({ cmd: 'presetApply', id: 1 });
    const sweep = await waitFor((m) => isState(m) && m.rpm === 8);
    assert.deepEqual(sweep.sweep, { fromDeg: -45, toDeg: 45, dwellMs: 1000, stopAfter: 'cycles', stopValue: 3 });

    send({ cmd: 'presetDelete', id: 0 });
    assert.deepEqual((await nextPresets()).presets.map((p) => p.name), ['Wide sweep']);
    send({ cmd: 'presetApply', id: 0 });
    assert.deepEqual(await waitFor((m) => m.type === 'error'), { type: 'error', msg: 'That preset was deleted' });
}));

test('saving under an existing name replaces it, and an 11th preset is refused', () => withDevice(async ({ next, nextPresets, send, waitFor }) => {
    await next();
    await nextPresets();
    for (let i = 0; i < 10; i++) {
        send({ cmd: 'presetSave', name: `Preset ${i}`, mode: 'spin' });
        await nextPresets();
    }

    send({ cmd: 'speed', rpm: 9 });
    send({ cmd: 'presetSave', name: 'Preset 4', mode: 'spin' });
    const presets = (await nextPresets()).presets;
    assert.equal(presets.length, 10);
    assert.equal(presets[4].rpm, 9);

    send({ cmd: 'presetSave', name: 'Preset 10', mode: 'spin' });
    assert.deepEqual(await waitFor((m) => m.type === 'error'), { type: 'error', msg: 'All 10 presets are used. Delete one first.' });
}));

// Poll the setup page's status endpoint until it matches.
async function waitForWifi(server, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const status = await (await fetch(`http://127.0.0.1:${server.port}/api/wifi/status`)).json();
        if (predicate(status)) {
            return status;
        }
        assert.ok(Date.now() < deadline, `timed out waiting for Wi-Fi status, last: ${JSON.stringify(status)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

const postForm = (server, path, fields = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
});

test('reports the Wi-Fi connection in the state', () => withDevice(async ({ next }) => {
    const msg = await next();
    assert.deepEqual(msg.wifi, { mode: 'lan', ssid: 'Home Wi-Fi', ip: '192.168.1.42', rssi: -58 });
}));

test('in setup, sends / to the setup page', () => withDevice(async (_, server) => {
    const base = `http://127.0.0.1:${server.port}`;
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/setup');
    const page = await fetch(`${base}/setup`);
    assert.match(await page.text(), /<title>Turntable setup<\/title>/);
}, { wifi: 'setup' }));

test('lists networks once the scan finishes', () => withDevice(async (_, server) => {
    const scanUrl = `http://127.0.0.1:${server.port}/api/wifi/scan`;
    const first = await (await fetch(scanUrl)).json();
    assert.equal(first.scanning, true);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const done = await (await fetch(scanUrl)).json();
    assert.equal(done.scanning, false);
    assert.deepEqual(done.networks.map((n) => n.ssid), ['Home Wi-Fi', 'Cafe Guest', 'Neighbour 2.4G']);
}, { wifi: 'setup' }));

test('rejects a bad network name or password', () => withDevice(async (_, server) => {
    const noName = await postForm(server, '/api/wifi/join', { ssid: '', password: '' });
    assert.equal(noName.status, 400);
    const shortPassword = await postForm(server, '/api/wifi/join', { ssid: 'Home Wi-Fi', password: 'short' });
    assert.equal(shortPassword.status, 400);
    assert.match((await shortPassword.json()).error, /8 to 63/);
}, { wifi: 'setup' }));

test('a wrong password goes back to setup with an error', () => withDevice(async (_, server) => {
    assert.equal((await postForm(server, '/api/wifi/join', { ssid: 'Home Wi-Fi', password: 'wrongpassword' })).status, 202);
    await waitForWifi(server, (s) => s.mode === 'joining');
    const failed = await waitForWifi(server, (s) => s.mode === 'setup');
    assert.match(failed.error, /password/);
}, { wifi: 'setup' }));

test('joining a network shows its address, then becomes a LAN client', () => withDevice(async (_, server) => {
    await postForm(server, '/api/wifi/join', { ssid: 'Home Wi-Fi', password: 'correct horse' });
    const joined = await waitForWifi(server, (s) => s.mode === 'joined');
    assert.equal(joined.ssid, 'Home Wi-Fi');
    assert.equal(joined.ip, '192.168.1.42');
    assert.equal(joined.hostname, 'turntable.local');
    await waitForWifi(server, (s) => s.mode === 'lan');
}, { wifi: 'setup' }));

test('access point mode goes straight to the control UI', () => withDevice(async (_, server) => {
    await postForm(server, '/api/wifi/ap');
    assert.equal((await waitForWifi(server, () => true)).mode, 'ap');
    const root = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: 'manual' });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>Turntable<\/title>/);
}, { wifi: 'setup' }));

test('wifiSetup restarts into setup', () => withDevice(async ({ ws, next, send }, server) => {
    await next();
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    send({ cmd: 'wifiSetup' });
    await closed;
    assert.equal((await waitForWifi(server, () => true)).mode, 'setup');
}));

test('handles messages that need a 16-bit length', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'speed', rpm: 7, pad: 'x'.repeat(2000) });
    assert.equal((await waitFor(isState)).rpm, 7);
}));

test('closes with 1009 when a message is too big', async () => {
    const { ws, next } = await connect();
    await next();
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    ws.send('x'.repeat(70 * 1024));
    assert.equal((await closed).code, 1009);
});

test('dropClients cuts connections so the UI can reconnect', async () => {
    const { ws, next } = await connect();
    await next();
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    // Earlier tests' sockets may still be closing, so count at least this one.
    assert.ok(mock.dropClients() >= 1);
    await closed;

    const again = await connect();
    assert.equal((await again.next()).type, 'state');
    again.ws.close();
});
