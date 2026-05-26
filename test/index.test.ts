import { CommandFirewall } from '../src/core/guardrails/CommandFirewall';
import { ErrorAnalyzer } from '../src/core/guardrails/ErrorAnalyzer';
import { TransactionManager } from '../src/core/rollback/TransactionManager';
import { CiscoAgentLoop } from '../src/core/agent/AgentLoop';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import * as assert from 'assert';

console.log('Running ciscollm-cli Unit Tests...\n');


console.log('[Test 1]: Evaluating CommandFirewall...');
const firewall = new CommandFirewall(['GigabitEthernet0/1']);


const check1 = firewall.checkCommand('write erase', null);
assert.strictEqual(check1.dangerous, true, 'write erase should be blocked');
assert.ok(check1.reason?.includes('Destructive keyword'), 'Should identify destructive keyword');


const check2 = firewall.checkCommand('shutdown', 'GigabitEthernet0/1');
assert.strictEqual(check2.dangerous, true, 'shutdown on GigabitEthernet0/1 should be blocked');
assert.ok(check2.reason?.includes('Cannot shutdown active protected'), 'Should identify protected interface block');


const check3 = firewall.checkCommand('show version', null);
assert.strictEqual(check3.dangerous, false, 'show version should be allowed');

const check4 = firewall.checkCommand('no shutdown', 'GigabitEthernet0/2');
assert.strictEqual(check4.dangerous, false, 'no shutdown on unprotected interface should be allowed');
console.log(' -> CommandFirewall test passed.');



console.log('\n[Test 2]: Evaluating ErrorAnalyzer...');
const err1 = ErrorAnalyzer.checkOutput('Router#configure terminal\n% Invalid input detected at \'^\' marker.');
assert.strictEqual(err1.hasError, true, 'Invalid input error should be caught');
assert.strictEqual(err1.errorType, 'InvalidInput', 'Error type should be InvalidInput');

const err2 = ErrorAnalyzer.checkOutput('Router#show ip interface brief\nInterface   IP-Address    OK? Method Status\nGig0/1      10.0.0.1      YES manual up');
assert.strictEqual(err2.hasError, false, 'Clean output should have no error');

const err3 = ErrorAnalyzer.checkOutput('% Bad interface parameter: gigabitethernet');
assert.strictEqual(err3.hasError, true, 'Bad interface parameter should be caught');
assert.strictEqual(err3.errorType, 'BadInterfaceParameter', 'Error type should be BadInterfaceParameter');

const err4 = ErrorAnalyzer.checkOutput('% Command rejected: Place in Privileged EXEC mode first.');
assert.strictEqual(err4.hasError, true, 'Command rejected should be caught');
assert.strictEqual(err4.errorType, 'CommandRejected', 'Error type should be CommandRejected');
console.log(' -> ErrorAnalyzer test passed.');



console.log('\n[Test 3]: Evaluating TransactionManager Command Inversion...');
const txManager = new TransactionManager();


txManager.trackMutation('interface GigabitEthernet0/2');
txManager.trackMutation('conf t');
txManager.trackMutation('ip address 192.168.1.1 255.255.255.0');
txManager.trackMutation('no shutdown');
txManager.trackMutation('description Test Interface');


const executedCommands: string[] = [];
const mockSession = {
    getState: () => ({ currentMode: 'UNKNOWN' as any, hostname: 'Router', prompt: '>' }),
    connect: async () => {},
    disconnect: async () => {},
    execute: async (cmd: string) => {
        executedCommands.push(cmd);
        return 'OK';
    }
} as any;


txManager.executeRollback(mockSession).then(() => {
    try {
        assert.deepStrictEqual(executedCommands, [
            'configure terminal',
            'interface GigabitEthernet0/2',
            'no description',
            'shutdown',
            'no ip address',
            'end'
        ], 'Rollback sequence should match expected inverse operation');
        console.log(' -> TransactionManager Inversion test passed.');
    } catch (e: any) {
        console.error(' -> TransactionManager Inversion test FAILED:', e.message);
        process.exit(1);
    }
}).catch((err) => {
    console.error('TransactionManager rollback error:', err);
    process.exit(1);
});



console.log('\n[Test 4]: Evaluating LLMClient Options...');
const clientLocal = new LLMClient('local');
assert.strictEqual((clientLocal as any).provider, 'local');
assert.strictEqual((clientLocal as any).modelName, 'qwen3.5-4b');

const clientCloud = new LLMClient('cloud', 'https://custom-url/v1', 'nvidia/nemotron-3-super-120b-a12b:free', 'test-key');
assert.strictEqual((clientCloud as any).provider, 'cloud');
assert.strictEqual((clientCloud as any).endpoint, 'https://custom-url/v1');
assert.strictEqual((clientCloud as any).modelName, 'nvidia/nemotron-3-super-120b-a12b:free');
assert.strictEqual((clientCloud as any).apiKey, 'test-key');
console.log(' -> LLMClient Provider Selection test passed.');



console.log('\n[Test 5]: Evaluating MultiAgentCoordinator...');
const coordinator = new MultiAgentCoordinator();
const mockDevice1 = {} as any;
const mockDevice2 = {} as any;
coordinator.registerSession('COM3', mockDevice1);
coordinator.registerSession('COM4', mockDevice2);

assert.strictEqual(coordinator.getSessions().size, 2, 'Should hold exactly 2 sessions');
assert.strictEqual(coordinator.getSession('COM3'), mockDevice1, 'Should resolve mockDevice1');
console.log(' -> MultiAgentCoordinator test passed.');



console.log('\n[Test 6]: Evaluating AgentLoop Output Truncation...');
const mockLLM = {} as any;
const agentLoop = new CiscoAgentLoop(mockLLM, coordinator);

const longOutput = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
const truncated = (agentLoop as any).truncateOutput(longOutput);
const lines = truncated.split('\n');

assert.strictEqual(lines.length, 41, 'Truncated output should have exactly 41 lines');
assert.ok(truncated.includes('TRUNCATED 60 LINES'), 'Should specify correct number of removed lines');
console.log(' -> AgentLoop Truncation test passed.');

console.log('\nAll Unit Tests Finished Successfully!');
