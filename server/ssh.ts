import { Server } from 'ssh2';
import { generateKeyPairSync } from 'crypto';
import { ShellSimulator } from './shell-simulator';

// Generate a host key dynamically so no pre-configured keys are needed
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

export function startSshServer(port: number, onLog: (msg: string) => void): Server {
    const server = new Server({
        hostKeys: [privateKey]
    }, (client: any) => {
        let username = '';

        client.on('authentication', (ctx: any) => {
            username = ctx.username;
            onLog(`SSH Auth attempt: User "${ctx.username}" via method "${ctx.method}"`);
            // Accept any password / key for mock testing purposes
            ctx.accept();
        });

        client.on('ready', () => {
            onLog(`SSH Client ready: "${username}"`);

            client.on('session', (accept: any, reject: any) => {
                const session = accept();
                session.on('pty', (accept: any, reject: any, info: any) => {
                    accept();
                });

                // 1. Handle Shell Request
                session.on('shell', (accept: any, reject: any) => {
                    const channel = accept();
                    onLog(`SSH Session: Shell channel opened for "${username}"`);
                    
                    const simulator = new ShellSimulator();
                    let lineBuffer = '';
                    let lastWasCr = false;

                    const welcomeBanner = `\r\nCisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)\r\nTechnical Support: http://www.cisco.com/techsupport\r\nCopyright (c) 1986-2013 by Cisco Systems, Inc.\r\nCompiled Wed 26-Jun-13 02:49 by prod_rel_team\r\n\r\n`;
                    channel.write(welcomeBanner + simulator.getPrompt());

                    const handleLine = () => {
                        channel.write('\r\n');
                        const cmd = lineBuffer.trim();
                        lineBuffer = '';

                        if (cmd.toLowerCase() === 'exit' && simulator.mode === 'USER_EXEC') {
                            channel.write('Connection closed by foreign host.\r\n');
                            channel.end();
                            return;
                        }

                        try {
                            const output = simulator.execute(cmd);
                            if (output) {
                                // Format output newlines for SSH console
                                channel.write(output.replace(/\n/g, '\r\n') + '\r\n');
                            }
                        } catch (err: any) {
                            channel.write(`% Error: ${err.message}\r\n`);
                        }
                        channel.write(simulator.getPrompt());
                    };

                    channel.on('data', (data: Buffer) => {
                        const input = data.toString('utf8');
                        
                        // Process character by character
                        for (let i = 0; i < input.length; i++) {
                            const char = input.charCodeAt(i);

                            if (char === 13) { // Carriage Return (CR)
                                lastWasCr = true;
                                handleLine();
                            } else if (char === 10) { // Line Feed (LF)
                                if (lastWasCr) {
                                    lastWasCr = false;
                                    continue;
                                }
                                handleLine();
                            } else if (char === 127 || char === 8) { // Backspace or Delete
                                lastWasCr = false;
                                if (lineBuffer.length > 0) {
                                    lineBuffer = lineBuffer.slice(0, -1);
                                    channel.write('\b \b');
                                }
                            } else if (char === 3) { // Ctrl+C
                                lastWasCr = false;
                                channel.write('^C\r\n');
                                lineBuffer = '';
                                channel.write(simulator.getPrompt());
                            } else {
                                lastWasCr = false;
                                const rawChar = input[i];
                                lineBuffer += rawChar;
                                channel.write(rawChar); // Echo back
                            }
                        }
                    });

                    channel.on('close', () => {
                        onLog(`SSH Session: Shell channel closed for "${username}"`);
                    });
                });

                // 2. Handle NETCONF Subsystem Request
                session.on('subsystem', (accept: any, reject: any, info: any) => {
                    if (info.name === 'netconf') {
                        const channel = accept();
                        onLog(`SSH Session: NETCONF subsystem opened for "${username}"`);
                        
                        let buffer = '';
                        let framing: '1.0' | '1.1' = '1.0';

                        // Send Server Hello
                        const helloMsg = `<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:xml:ns:netconf:base:1.0</capability>
    <capability>urn:ietf:params:netconf:base:1.1</capability>
  </capabilities>
  <session-id>42</session-id>
</hello>]]>]]>`;
                        channel.write(helloMsg);

                        channel.on('data', (data: Buffer) => {
                            buffer += data.toString('utf8');
                            
                            while (true) {
                                if (framing === '1.0') {
                                    const delim = ']]>]]>';
                                    const index = buffer.indexOf(delim);
                                    if (index === -1) break;
                                    
                                    const msg = buffer.slice(0, index);
                                    buffer = buffer.slice(index + delim.length);
                                    
                                    processNetconfMessage(msg);
                                } else {
                                    // 1.1 Framing: \n#${len}\n${payload}\n##\n
                                    const match = buffer.match(/^\r?\n#(\d+)\r?\n/);
                                    if (!match) break;
                                    
                                    const header = match[0];
                                    const len = parseInt(match[1], 10);
                                    const payloadStart = match.index! + header.length;
                                    
                                    if (buffer.length < payloadStart + len + 4) break; // Not enough data yet
                                    
                                    const payload = buffer.slice(payloadStart, payloadStart + len);
                                    const tail = buffer.slice(payloadStart + len, payloadStart + len + 4);
                                    
                                    if (!tail.includes('##')) {
                                        // Error parsing framing
                                        onLog(`NETCONF 1.1 Framing Error. Tail is: ${JSON.stringify(tail)}`);
                                        channel.end();
                                        break;
                                    }
                                    
                                    buffer = buffer.slice(payloadStart + len + 4);
                                    processNetconfMessage(payload);
                                }
                            }
                        });

                        const sendResponse = (payload: string) => {
                            if (framing === '1.1') {
                                const len = Buffer.byteLength(payload, 'utf8');
                                channel.write(`\n#${len}\n${payload}\n##\n`);
                            } else {
                                channel.write(`${payload}]]>]]>`);
                            }
                        };

                        const processNetconfMessage = (xml: string) => {
                            onLog(`NETCONF RPC Received: ${xml.trim().substring(0, 100)}...`);
                            
                            if (xml.includes('<hello')) {
                                // Peer hello exchange
                                if (xml.includes('netconf:base:1.1')) {
                                    framing = '1.1';
                                    onLog(`NETCONF Framed Negotiated: 1.1`);
                                } else {
                                    framing = '1.0';
                                    onLog(`NETCONF Framed Negotiated: 1.0`);
                                }
                                return;
                            }

                            // Extract message-id
                            const msgIdMatch = /message-id=["']([^"']+)["']/i.exec(xml);
                            const messageId = msgIdMatch ? msgIdMatch[1] : '1';

                            if (xml.includes('<edit-config>')) {
                                sendResponse(`<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">
  <ok/>
</rpc-reply>`);
                            } else if (xml.includes('<get-config>') || xml.includes('<get>')) {
                                sendResponse(`<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">
  <data>
    <native xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-native">
      <hostname>Switch1</hostname>
    </native>
  </data>
</rpc-reply>`);
                            } else {
                                sendResponse(`<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">
  <ok/>
</rpc-reply>`);
                            }
                        };

                        channel.on('close', () => {
                            onLog(`SSH Session: NETCONF subsystem closed for "${username}"`);
                        });
                    } else {
                        reject();
                    }
                });
            });
        });

        client.on('close', () => {
            onLog(`SSH Connection closed for "${username || 'unauthenticated'}"`);
        });

        client.on('error', (err: any) => {
            onLog(`SSH Connection error: ${err.message}`);
        });
    });

    server.listen(port, '0.0.0.0', () => {
        onLog(`SSH & NETCONF Server listening on port ${port}`);
    });

    return server;
}
