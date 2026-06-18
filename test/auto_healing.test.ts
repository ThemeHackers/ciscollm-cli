import { startTelnetServer } from '../src/server/telnet';
import { TelnetSession } from '../src/infrastructure/protocols/TelnetSession';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import { AutoHealer } from '../src/core/agent/AutoHealer';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import { simulatorEvents } from '../src/server/shell-simulator';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runTest() {
    console.log('Running Auto-Healing Closed-Loop Integration Test...');

    const TELNET_PORT = 2324;
    const logFilePath = path.resolve(process.cwd(), 'test-healing-audit.log');
    
    if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
    }

    const serverLogs: string[] = [];
    const server = startTelnetServer(TELNET_PORT, (msg) => {
        serverLogs.push(msg);
    });

    await new Promise(r => setTimeout(r, 500));

    const coordinator = new MultiAgentCoordinator();
    const session = new TelnetSession({
        host: '127.0.0.1',
        port: TELNET_PORT,
        username: 'admin',
        password: 'password'
    });
    coordinator.registerSession('Switch1', session);

    const mockLlm = {
        getModelName: () => 'mock-ai-model',
        ensureReachable: async () => true,
        generateCompletion: async (messages: any[]) => {
            const lastMsg = messages[messages.length - 1].content;
            
            if (lastMsg.includes('Verification Outputs:')) {
                return {
                    role: 'assistant',
                    content: 'SUCCESS'
                };
            } else {
                const responseJson = {
                    detected_issue: 'Port GigabitEthernet0/1 is shut down',
                    root_cause: 'Administratively disabled',
                    confidence: 0.98,
                    remediation_commands: [
                        'configure terminal',
                        'interface GigabitEthernet0/1',
                        'no shutdown',
                        'end'
                    ],
                    verification_commands: [
                        'show ip interface brief'
                    ]
                };
                return {
                    role: 'assistant',
                    content: JSON.stringify(responseJson)
                };
            }
        }
    } as unknown as LLMClient;

    let healer: AutoHealer | null = null;
    try {
        await coordinator.connectAll();

        healer = new AutoHealer(mockLlm, coordinator, {
            nonInteractive: true,
            minConfidence: 0.80,
            logFile: 'test-healing-audit.log'
        });
        healer.start();

        const checkBefore = await session.execute('show ip interface brief');
        assert.ok(checkBefore.includes('GigabitEthernet0/1'), 'Gi0/1 should exist in output');
        assert.ok(checkBefore.includes('administratively down'), 'Gi0/1 should initially be administratively down');

        console.log(' -> Emitting simulated syslog alert...');
        simulatorEvents.emit('syslog', '%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down');

        console.log(' -> Waiting for Auto-Healing loop execution...');
        await new Promise(r => setTimeout(r, 4500));

        const checkAfter = await session.execute('show ip interface brief');
        console.log(' -> Verification Output:\n', checkAfter);

        const gi01Line = checkAfter.split('\n').find(line => line.includes('GigabitEthernet0/1'));
        assert.ok(gi01Line, 'GigabitEthernet0/1 line should be found in output');
        assert.ok(!gi01Line.includes('administratively down'), 'Gi0/1 should no longer be administratively down');
        assert.ok(gi01Line.includes('up'), 'Gi0/1 status/protocol should be up');

        assert.ok(fs.existsSync(logFilePath), 'Healing audit log file should be generated');
        const logs = fs.readFileSync(logFilePath, 'utf8');
        console.log(' -> Healing Audit Log Content:\n', logs);
        assert.ok(logs.includes('[TRIGGERED]'), 'Audit log should record trigger event');
        assert.ok(logs.includes('[SUCCESS]'), 'Audit log should record success status');

        console.log(' -> Closed-Loop Auto-Healing Integration Test passed successfully!');
        
    } catch (e: any) {
        console.error('Integration Test FAILED:', e.stack || e.message);
        process.exit(1);
    } finally {
        if (healer) {
            healer.stop();
        }
        await coordinator.disconnectAll();
        server.close();
        
        if (fs.existsSync(logFilePath)) {
            fs.unlinkSync(logFilePath);
        }
    }
}

runTest().then(() => {
    console.log('Auto-Healing tests completed.');
    process.exit(0);
});
