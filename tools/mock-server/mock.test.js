// Tests for the mock server. Run with `node --test tools/mock-server/mock.test.js`
// (Node 22.4+, which has a built-in WebSocket client).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startMockServer } from './mock.js';

let mock;
let baseUrl;
let wsUrl;

before(async () => {
    mock = await startMockServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${mock.port}`;
    wsUrl = `ws://127.0.0.1:${mock.port}/ws`;
});

after(() => mock.close());

// Open a WebSocket and queue its messages, so none are missed between awaits.
async function connect() {
    const ws = new WebSocket(wsUrl);
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
    return { ws, next, send };
}

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
    assert.match(await res.text(), /<title>Web Turntable<\/title>/);

    const css = await fetch(`${baseUrl}/style.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
});

test('does not serve files outside the data folder', async () => {
    assert.equal(await rawGet('/..%2fserver.cpp'), 403);
    assert.equal(await rawGet('/..%2f..%2f..%2fCLAUDE.md'), 403);
});

test('sends the current state on connect', async () => {
    const { ws, next } = await connect();
    assert.deepEqual(await next(), { stepping_direction: 1, stepping_speed: 0, stepping_mode: 0 });
    ws.close();
});

test('broadcasts each change to every client', async () => {
    const a = await connect();
    const b = await connect();
    await a.next();
    await b.next();

    a.send({ type: 'stepping_speed', content: 50 });
    assert.equal((await a.next()).stepping_speed, 50);
    assert.equal((await b.next()).stepping_speed, 50);

    // The v1 UI sends 2 for CCW; the firmware accepts and echoes it.
    b.send({ type: 'stepping_direction', content: 2 });
    assert.equal((await a.next()).stepping_direction, 2);
    assert.equal((await b.next()).stepping_direction, 2);

    a.ws.close();
    b.ws.close();
});

test('validates commands like the firmware', async () => {
    const { ws, next, send } = await connect();
    await next();

    send({ type: 'stepping_speed', content: 150 });
    assert.equal((await next()).stepping_speed, 100);

    send({ type: 'stepping_mode', content: 7 });
    assert.equal((await next()).stepping_mode, 0);

    // Non-JSON and unknown types get no reply; the next valid command still works.
    ws.send('not json');
    send({ type: 'bogus', content: 1 });
    send({ type: 'stepping_mode', content: 1 });
    assert.equal((await next()).stepping_mode, 1);

    ws.close();
});

test('handles messages that need a 16-bit length', async () => {
    const { ws, next, send } = await connect();
    await next();
    send({ type: 'stepping_speed', content: 25, pad: 'x'.repeat(2000) });
    assert.equal((await next()).stepping_speed, 25);
    ws.close();
});

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
    assert.ok('stepping_speed' in (await again.next()));
    again.ws.close();
});
