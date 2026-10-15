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
async function connect(server = mock) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const queue = [];
    const waiters = [];
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const waiter = waiters.shift();
        waiter ? waiter(msg) : queue.push(msg);
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    const next = () => queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push(resolve));
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
    return { ws, next, send, waitFor };
}

// Run a protocol test against its own mock, so device state doesn't leak between tests.
async function withDevice(body) {
    const server = await startMockServer({ port: 0 });
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

test('sends the full state on connect', () => withDevice(async ({ next }) => {
    const msg = await next();
    assert.equal(msg.type, 'state');
    assert.equal(msg.motion, 'idle');
    assert.equal(msg.angle, 0);
    assert.equal(msg.rpm, 5);
    assert.equal(msg.dir, 'cw');
    assert.equal(msg.spinning, false);
    assert.deepEqual(msg.settings, { driveMode: 'half', maxRpm: 15, accel: 20 });
    assert.deepEqual(msg.limits, { minRpm: 0.5, maxRpm: 30, minAccel: 1, maxAccel: 200 });
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
}));

test('clamps speed to the limits and max speed', () => withDevice(async ({ next, send, waitFor }) => {
    await next();
    send({ cmd: 'speed', rpm: 99 });
    assert.equal((await waitFor(isState)).rpm, 15);
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
