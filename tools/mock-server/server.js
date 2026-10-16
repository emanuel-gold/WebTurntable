// Command-line entry for the mock turntable. Run `node tools/mock-server/server.js --help`.

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

import { DEFAULT_DATA_DIR, PROTOCOLS, startMockServer } from './mock.js';

const USAGE = `Usage: node tools/mock-server/server.js [options]

Serves the web UI and fakes the turntable's WebSocket at /ws.

Options:
  -p, --port <n>        HTTP port (default 8080)
      --host <addr>     Bind address (default 127.0.0.1; use 0.0.0.0 to test from a phone on the LAN)
      --data <dir>      Web UI folder (default code/WebTurntable/data)
      --protocol <v>    Protocol to emulate: ${Object.keys(PROTOCOLS).join(', ')} (default v2)
      --wifi <mode>     Start as a LAN client (lan, default) or in Wi-Fi setup (setup)
  -h, --help            Show this help

While running, type a command and press Enter:
  state   print the device state
  drop    cut every WebSocket connection, to test UI reconnects
  quit    stop the server`;

// Timestamped like a serial monitor line.
function log(line) {
    const time = new Date().toTimeString().slice(0, 8);
    console.log(`${time}  ${line}`);
}

// Addresses a phone on the same network could use, for the startup banner.
function lanAddresses() {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((nic) => nic && nic.family === 'IPv4' && !nic.internal)
        .map((nic) => nic.address);
}

async function main() {
    let args;
    try {
        ({ values: args } = parseArgs({
            options: {
                port: { type: 'string', short: 'p', default: '8080' },
                host: { type: 'string', default: '127.0.0.1' },
                data: { type: 'string', default: DEFAULT_DATA_DIR },
                protocol: { type: 'string', default: 'v2' },
                wifi: { type: 'string', default: 'lan' },
                help: { type: 'boolean', short: 'h', default: false },
            },
        }));
    } catch (err) {
        console.error(`${err.message}\n\n${USAGE}`);
        process.exit(2);
    }
    if (args.help) {
        console.log(USAGE);
        return;
    }

    const mock = await startMockServer({
        port: Number(args.port),
        host: args.host,
        dataDir: path.resolve(args.data),
        protocol: args.protocol,
        wifi: args.wifi,
        log,
    });

    const hosts = args.host === '0.0.0.0' ? ['localhost', ...lanAddresses()] : [args.host];
    log(`Mock turntable (protocol ${mock.protocol}) serving ${mock.dataDir}`);
    hosts.forEach((h) => log(`  http://${h}:${mock.port}/`));
    log(`Wi-Fi starts in ${args.wifi} mode; the setup page is at /setup`);
    log('Commands: state, drop, quit');

    const shutdown = async () => {
        await mock.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);

    // stdin may be closed when run in the background; the server keeps running.
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        switch (line.trim()) {
            case 'state':
                log(`State: ${mock.device.describe()}`);
                break;
            case 'drop':
                log(`Dropped ${mock.dropClients()} client(s)`);
                break;
            case 'quit':
            case 'exit':
                shutdown();
                break;
            case '':
                break;
            default:
                log('Commands: state, drop, quit');
        }
    });
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
