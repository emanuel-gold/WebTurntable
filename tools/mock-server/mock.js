// Mock turntable: serves the web UI from data/ over HTTP and emulates the
// firmware's WebSocket protocol at /ws, so the UI can be built without hardware.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acceptUpgrade } from './websocket.js';
import * as protocolV2 from './protocol-v2.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_DIR = path.resolve(here, '../../code/WebTurntable/data');

// Each protocol module exports createDevice({ broadcast, log }).
export const PROTOCOLS = {
    v2: protocolV2,
};

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
};

// Start the mock. Resolves once listening; port 0 picks a free port.
export async function startMockServer({
    port = 8080,
    host = '127.0.0.1',
    dataDir = DEFAULT_DATA_DIR,
    protocol = 'v2',
    wifi = 'lan',
    log = () => {},
} = {}) {
    if (!PROTOCOLS[protocol]) {
        throw new Error(`Unknown protocol "${protocol}" (have: ${Object.keys(PROTOCOLS).join(', ')})`);
    }

    const clients = new Set();
    const broadcast = (text) => clients.forEach((client) => client.send(text));
    // A firmware restart drops every WebSocket, as the real reboot would.
    const restart = () => clients.forEach((client) => client.drop());
    const device = PROTOCOLS[protocol].createDevice({ broadcast, log, wifi, restart });

    const server = createServer(async (req, res) => {
        const url = req.url;
        // The device answers its own routes (the Wi-Fi setup API); everything else is a file.
        const status = (device.handleHttp && await device.handleHttp(req, res)) || await serveStatic(req, res, dataDir);
        log(`[${req.socket.remoteAddress}] HTTP ${req.method} ${url} ${status}`);
    });

    server.on('upgrade', (req, socket, head) => {
        if (new URL(req.url, 'http://mock').pathname !== '/ws') {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        acceptUpgrade(req, socket, head, (client) => {
            clients.add(client);
            client.on('message', (text) => device.onMessage(client, text));
            client.on('close', () => {
                clients.delete(client);
                device.onDisconnect(client);
            });
            device.onConnect(client);
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });

    return {
        port: server.address().port,
        host,
        dataDir,
        protocol,
        clients,
        device,
        // Cut every connection without a close frame, to test UI reconnects.
        dropClients() {
            const count = clients.size;
            clients.forEach((client) => client.drop());
            return count;
        },
        close() {
            device.close();
            clients.forEach((client) => client.drop());
            return new Promise((resolve) => server.close(resolve));
        },
    };
}

// Serve one file from dataDir, never from outside it. Returns the HTTP status.
async function serveStatic(req, res, dataDir) {
    const send = (status, body = '', headers = {}) => {
        res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
        return status;
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(405, 'Method not allowed');
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://mock').pathname);
    } catch {
        return send(400, 'Bad request');
    }
    if (pathname.endsWith('/')) {
        pathname += 'index.html';
    }

    const file = path.join(dataDir, pathname);
    const relative = path.relative(dataDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return send(403, 'Forbidden');
    }

    let body;
    try {
        body = await readFile(file);
    } catch {
        return send(404, 'Not found');
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return send(200, body, { 'Content-Type': type, 'Content-Length': body.length });
}
