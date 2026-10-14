// Minimal RFC 6455 WebSocket server side: enough for small JSON text frames
// between the web UI and the mock device, with no npm dependencies.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_BIG = 1009;

// Complete the HTTP upgrade handshake and hand the connected client to onClient.
export function acceptUpgrade(req, socket, head, onClient) {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
    }

    const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);

    const client = new WebSocketClient(socket, req.socket.remoteAddress);
    onClient(client);
    if (head.length > 0) {
        client.feed(head);
    }
}

// One connected client. Emits 'message' (text payload) and 'close' (once).
export class WebSocketClient extends EventEmitter {
    constructor(socket, remoteAddress) {
        super();
        this.socket = socket;
        this.remoteAddress = remoteAddress;
        this.open = true;
        this.finished = false;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentBytes = 0;

        socket.on('data', (chunk) => this.feed(chunk));
        socket.on('close', () => this.finish());
        socket.on('error', () => this.finish());
    }

    // Send a text message. Does nothing once the connection is closing.
    send(text) {
        if (this.open) {
            this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
        }
    }

    // Close cleanly with a close frame, as a browser or the firmware would.
    close(code = 1000, reason = '') {
        if (!this.open) {
            return;
        }
        this.open = false;
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        this.socket.end(encodeFrame(OP_CLOSE, payload));
        setTimeout(() => this.socket.destroy(), 1000).unref();
    }

    // Drop the TCP connection without a close frame, like a device losing power.
    drop() {
        this.open = false;
        this.socket.destroy();
    }

    // Append received bytes and process every complete frame.
    feed(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        while (this.open) {
            const frame = decodeFrame(this.buffer);
            if (frame === null) {
                return;
            }
            if (frame.error) {
                this.close(frame.error);
                return;
            }
            this.buffer = this.buffer.subarray(frame.size);
            this.handleFrame(frame);
        }
    }

    // React to one decoded frame: control frames inline, data frames reassembled.
    handleFrame({ fin, opcode, payload }) {
        switch (opcode) {
            case OP_CLOSE:
                this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
                return;
            case OP_PING:
                this.socket.write(encodeFrame(OP_PONG, payload));
                return;
            case OP_PONG:
                return;
            case OP_TEXT:
            case OP_BINARY:
            case OP_CONTINUATION:
                break;
            default:
                this.close(CLOSE_PROTOCOL_ERROR);
                return;
        }

        // A new message must not start mid-fragment, and a continuation needs a start.
        const startsMessage = opcode !== OP_CONTINUATION;
        if (startsMessage === (this.fragments.length > 0)) {
            this.close(CLOSE_PROTOCOL_ERROR);
            return;
        }
        if (startsMessage) {
            this.fragmentOpcode = opcode;
            this.fragmentBytes = 0;
        }

        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
            this.close(CLOSE_TOO_BIG);
            return;
        }
        this.fragments.push(payload);

        if (fin) {
            const message = Buffer.concat(this.fragments);
            this.fragments = [];
            // The firmware only handles text frames, so binary ones are dropped.
            if (this.fragmentOpcode === OP_TEXT) {
                this.emit('message', message.toString('utf8'));
            }
        }
    }

    // Emit 'close' exactly once, however the connection ended.
    finish() {
        if (!this.finished) {
            this.finished = true;
            this.open = false;
            this.emit('close');
        }
    }
}

// Build an unmasked server-to-client frame.
function encodeFrame(opcode, payload) {
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xffff) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
}

// Decode one masked client frame from the start of buf.
// Returns null if more bytes are needed, or { error } for a protocol violation.
function decodeFrame(buf) {
    if (buf.length < 2) {
        return null;
    }

    const fin = (buf[0] & 0x80) !== 0;
    const reserved = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    const isControl = (opcode & 0x8) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    // Clients must mask every frame; no extensions are negotiated, so RSV bits stay 0.
    if (!masked || reserved !== 0 || (isControl && (!fin || length > 125))) {
        return { error: CLOSE_PROTOCOL_ERROR };
    }

    if (length === 126) {
        if (buf.length < 4) {
            return null;
        }
        length = buf.readUInt16BE(2);
        offset = 4;
    } else if (length === 127) {
        if (buf.length < 10) {
            return null;
        }
        const bigLength = buf.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_MESSAGE_BYTES)) {
            return { error: CLOSE_TOO_BIG };
        }
        length = Number(bigLength);
        offset = 10;
    }

    if (length > MAX_MESSAGE_BYTES) {
        return { error: CLOSE_TOO_BIG };
    }
    if (buf.length < offset + 4 + length) {
        return null;
    }

    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
        payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
    }

    return { fin, opcode, payload, size: offset + 4 + length };
}
