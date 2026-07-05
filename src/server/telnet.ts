import net from 'net';
import { BaseDevice, simulatorEvents } from './devices/BaseDevice';

export function startTelnetServer(port: number, onLog: (msg: string) => void, simulator: BaseDevice): net.Server {
    const server = net.createServer((socket) => {
        onLog(`Telnet Connection established from ${socket.remoteAddress}:${socket.remotePort}`);

      
        socket.write(Buffer.from([255, 251, 1, 255, 251, 3]));

        
        socket.write('\r\nUser Access Verification\r\n\r\nUsername: ');

        let authState: 'NEEDS_USER' | 'NEEDS_PASS' | 'ACTIVE' = 'NEEDS_USER';
        let username = '';
        let password = '';
        let lineBuffer = '';
        let lastWasCr = false;

        const handleLine = () => {
            socket.write('\r\n');
            const cmd = lineBuffer.trim();
            lineBuffer = '';

            if (authState === 'NEEDS_USER') {
                username = cmd;
                authState = 'NEEDS_PASS';
                socket.write('Password: ');
            } else if (authState === 'NEEDS_PASS') {
                password = cmd;
                authState = 'ACTIVE';
                onLog(`Telnet Authenticated user: "${username}"`);
                

                const { BOOT_BANNER } = require('../shared/bootBanner');
                socket.write(BOOT_BANNER.replace(/\n/g, '\r\n') + '\r\n\r\n         --- System Configuration Dialog ---\r\n\r\nWould you like to enter the initial configuration dialog? [yes/no]: no\r\n\r\n\r\nPress RETURN to get started!\r\n\r\n' + simulator.getPrompt());

                const sysLogListener = (msg: string) => {
                    try {
                        socket.write(`\r\n${msg}\r\n` + simulator.getPrompt());
                    } catch {}
                };
                const { simulatorEvents } = require('./devices/BaseDevice');
                simulatorEvents.on('syslog', sysLogListener);

                socket.on('close', () => {
                    simulatorEvents.removeListener('syslog', sysLogListener);
                });
            } else {

                if (cmd.toLowerCase() === 'exit' && simulator.mode === 'USER_EXEC') {
                    socket.write('Connection closed by foreign host.\r\n');
                    socket.end();
                    return;
                }

                try {
                    const output = simulator.processCommand(cmd);
                    if (output) {
                        socket.write(output.replace(/\n/g, '\r\n') + '\r\n');
                    }
                } catch (err: any) {
                    socket.write(`% Error: ${err.message}\r\n`);
                }
                socket.write(simulator.getPrompt());
            }
        };

        socket.on('data', (data) => {
          
            const cleaned: number[] = [];
            let i = 0;
            while (i < data.length) {
                const byte = data[i];
                if (byte === 255) { 
                    const cmd = data[i + 1];
                    if (cmd >= 251 && cmd <= 254) {

                        const option = data[i + 2];
                        const response = Buffer.from([255, cmd === 251 ? 253 : 252, option]);
                        socket.write(response);
                        i += 3;
                    } else {
                        i += 2;
                    }
                } else {
                    cleaned.push(byte);
                    i++;
                }
            }

            if (cleaned.length === 0) return;

            const input = Buffer.from(cleaned).toString('utf8');

            for (let j = 0; j < input.length; j++) {
                const char = input.charCodeAt(j);

                if (char === 13) {
                    lastWasCr = true;
                    handleLine();
                } else if (char === 10) {
                    if (lastWasCr) {
                        lastWasCr = false;
                        continue;
                    }
                    handleLine();
                } else if (char === 127 || char === 8) {
                    lastWasCr = false;
                    if (lineBuffer.length > 0) {
                        lineBuffer = lineBuffer.slice(0, -1);

                        if (authState !== 'NEEDS_PASS') {
                            socket.write('\b \b');
                        }
                    }
                } else if (char === 3) {
                    lastWasCr = false;
                    socket.write('^C\r\n');
                    lineBuffer = '';
                    if (authState === 'ACTIVE') {
                        socket.write(simulator.getPrompt());
                    } else if (authState === 'NEEDS_USER') {
                        socket.write('Username: ');
                    } else {
                        socket.write('Password: ');
                    }
                } else {
                    lastWasCr = false;
                    const rawChar = input[j];
                    lineBuffer += rawChar;

                    if (authState !== 'NEEDS_PASS') {
                        socket.write(rawChar);
                    }
                }
            }
        });

        socket.on('close', () => {
            onLog(`Telnet Connection closed`);
        });

        socket.on('error', (err) => {
            onLog(`Telnet Socket error: ${err.message}`);
        });
    });

    server.listen(port, '0.0.0.0', () => {
        onLog(`Telnet Server listening on port ${port}`);
    });

    return server;
}
