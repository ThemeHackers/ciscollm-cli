import { AutoHealer } from '../src/core/agent/AutoHealer';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runLivelockTest() {
    console.log('Running AutoHealer Livelock Cooldown Unit Test...');

    const logFile = 'test-livelock-audit.log';
    const logFilePath = path.resolve(process.cwd(), logFile);
    if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
    }

    const coordinator = new MultiAgentCoordinator();
  
    const mockSession = {
        deviceId: 'Switch1',
        getState: () => ({ currentMode: 'GLOBAL_CONFIG' }),
        execute: async (cmd: string) => {
            if (cmd.includes('show ip interface brief')) {
                return 'GigabitEthernet0/1 up up';
            }
            return 'OK';
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {}
    } as any;
    coordinator.registerSession('Switch1', mockSession);

    const mockLlm = {
        generateCompletion: async () => {
            return {
                content: JSON.stringify({
                    detected_issue: 'Interface flapping',
                    root_cause: 'Hardware failure',
                    confidence: 0.99,
                    remediation_commands: ['interface GigabitEthernet0/1', 'no shutdown'],
                    verification_commands: ['show ip interface brief']
                })
            };
        }
    } as any;

    const healer = new AutoHealer(mockLlm, coordinator, {
        nonInteractive: true,
        minConfidence: 0.80,
        logFile: logFile
    });

    healer.start();

    
    console.log(' -> Emitting trigger 1...');
    coordinator.emit('notification', '%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down', 'Switch1');
    await new Promise(r => setTimeout(r, 200));

    console.log(' -> Emitting trigger 2...');
    coordinator.emit('notification', '%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down', 'Switch1');
    await new Promise(r => setTimeout(r, 200));

    console.log(' -> Emitting trigger 3...');
    coordinator.emit('notification', '%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down', 'Switch1');
    await new Promise(r => setTimeout(r, 200));

   
    console.log(' -> Emitting trigger 4 (should trigger cooldown)...');
    coordinator.emit('notification', '%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down', 'Switch1');
    await new Promise(r => setTimeout(r, 500));

   
    healer.stop();

    assert.ok(fs.existsSync(logFilePath), 'Audit log file should be generated');
    const logs = fs.readFileSync(logFilePath, 'utf8');
    console.log(' -> Log Contents:\n', logs);

    assert.ok(logs.includes('[ACTIVATED-COOLDOWN]'), 'Log should indicate cooldown activation');
    

    if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
    }

    console.log('AutoHealer Livelock Cooldown Unit Test passed successfully!');
    process.exit(0);
}

runLivelockTest().catch(err => {
    console.error('Test FAILED:', err.stack || err.message || err);
    process.exit(1);
});
