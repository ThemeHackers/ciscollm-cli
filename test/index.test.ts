process.env.NODE_ENV = 'test';
import { CommandFirewall } from '../src/core/guardrails/CommandFirewall';
import { ErrorAnalyzer } from '../src/core/guardrails/ErrorAnalyzer';
import { TransactionManager } from '../src/core/rollback/TransactionManager';
import { CiscoAgentLoop } from '../src/core/agent/AgentLoop';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import { HierarchicalAgentManager } from '../src/core/agent/HierarchicalAgentManager';
import { PreExecutionValidator } from '../src/core/guardrails/PreExecutionValidator';
import { StateDiff } from '../src/core/rollback/StateDiff';
import { NetconfSession } from '../src/infrastructure/protocols/NetconfSession';
import { PlinkSerialSession } from '../src/infrastructure/protocols/PlinkSerial';
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
assert.strictEqual((clientLocal as any).modelName, 'qwen3.5:4b');

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

console.log('\n[Test 7]: Evaluating HierarchicalAgentManager...');
const role1 = HierarchicalAgentManager.routeCommand('ip route 0.0.0.0 0.0.0.0 10.0.0.1');
assert.strictEqual(role1, 'CORE', 'Static route should be routed to CORE agent');
const role2 = HierarchicalAgentManager.routeCommand('vlan 10');
assert.strictEqual(role2, 'DISTRIBUTION', 'VLAN commands should be routed to DISTRIBUTION agent');
const role3 = HierarchicalAgentManager.routeCommand('interface GigabitEthernet0/1');
assert.strictEqual(role3, 'ACCESS', 'Interface commands should be routed to ACCESS agent');
console.log(' -> HierarchicalAgentManager test passed.');

console.log('\n[Test 8]: Evaluating Cisco command classifier...');
const commandClassifier = (agentLoop as any).classifyCommand.bind(agentLoop);
assert.strictEqual(commandClassifier('show ip interface brief'), 'inspection', 'Show commands should be classified as inspection');
assert.strictEqual(commandClassifier('show cdp neighbors detail'), 'inspection', 'Neighbor discovery shows should be classified as inspection');
assert.strictEqual(commandClassifier('interface GigabitEthernet0/1'), 'configuration', 'Interface commands should be classified as configuration');
assert.strictEqual(commandClassifier('router ospf 1'), 'configuration', 'Routing process commands should be classified as configuration');
assert.strictEqual(commandClassifier('ip access-list extended MGMT'), 'configuration', 'ACL configuration should be classified as configuration');
assert.strictEqual(commandClassifier('terminal shell'), 'configuration', 'IOS shell activation should be classified as configuration');
console.log(' -> Cisco command classifier test passed.');

console.log('\n[Test 9]: Evaluating PreExecutionValidator...');
const mockTopology = {
    devices: [{ id: 'Switch1', type: 'switch' as any, interfaces: [] }, { id: 'Router1', type: 'router' as any, interfaces: [] }],
    links: [{
        id: 'link1',
        localDeviceId: 'Switch1',
        localInterface: 'GigabitEthernet0/1',
        remoteDeviceId: 'Router1',
        remoteInterface: 'GigabitEthernet0/1',
        protocol: 'lldp'
    }]
} as any;
const val1 = PreExecutionValidator.validateCommand('no ip route 0.0.0.0', 'Router1', mockTopology, null);
assert.strictEqual(val1.safe, false, 'Default route deletion should be flagged unsafe');
assert.strictEqual(val1.warnLevel, 'CRITICAL', 'Default route deletion warning should be CRITICAL');

const val2 = PreExecutionValidator.validateCommand('shutdown', 'Switch1', mockTopology, 'GigabitEthernet0/1');
assert.strictEqual(val2.safe, false, 'Shutting down active link should be flagged unsafe');
assert.strictEqual(val2.warnLevel, 'CRITICAL', 'Warning should be CRITICAL');
console.log(' -> PreExecutionValidator test passed.');

console.log('\n[Test 10]: Evaluating StateDiff...');
const beforeSnap = {
    deviceId: 'Router1',
    timestamp: '2026-05-27T00:00:00Z',
    sessionState: { currentMode: 'PRIVILEGED_EXEC' as any, hostname: 'Router1', prompt: 'Router1#' },
    interfaces: [
        { name: 'GigabitEthernet0/1', ip: '10.0.0.1', subnet: '255.255.255.0', adminShutdown: false, lineProtocolUp: true, description: 'Uplink' }
    ],
    routes: [],
    vlans: [1]
};
const afterSnap = {
    deviceId: 'Router1',
    timestamp: '2026-05-27T00:01:00Z',
    sessionState: { currentMode: 'PRIVILEGED_EXEC' as any, hostname: 'Router-Main', prompt: 'Router-Main#' },
    interfaces: [
        { name: 'GigabitEthernet0/1', ip: '10.0.0.2', subnet: '255.255.255.0', adminShutdown: false, lineProtocolUp: true, description: 'Uplink to Core' }
    ],
    routes: [{ network: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.10' }],
    vlans: [1, 10]
};
const diff = StateDiff.diff(beforeSnap, afterSnap);
assert.ok(diff.hostnameChanged, 'Hostname changes should be caught');
assert.strictEqual(diff.hostnameChanged.after, 'Router-Main');
assert.strictEqual(diff.addedVlans.includes(10), true, 'VLAN 10 addition should be caught');
assert.strictEqual(diff.addedRoutes.length, 1, 'Static route addition should be caught');
console.log(' -> StateDiff test passed.');


console.log('\n[Test 11]: Evaluating NetconfSession Framing and Parsing...');
const netconfSession = new NetconfSession('127.0.0.1', 830, { username: 'test', password: 'test' });
const framed10 = netconfSession.frameMessage('<hello/>', '1.0');
assert.strictEqual(framed10, '<hello/>]]>]]>', 'Framing 1.0 format should be correct');

const framed11 = netconfSession.frameMessage('<hello/>', '1.1');
assert.strictEqual(framed11, '\n#8\n<hello/>\n##\n', 'Framing 1.1 format should be correct');

const rpcReq = netconfSession.buildRpcRequest({
    target: 'running',
    config: { 'test-node': 'val' },
    messageId: 'test-msg-123'
});
assert.ok(rpcReq.includes('message-id="test-msg-123"'), 'RPC request builder should include correct message-id');
console.log(' -> NetconfSession Framing and Parsing test passed.');


console.log('\n[Test 13]: Evaluating LLMClient Token Estimation...');
const testClient = new LLMClient('local');
const promptTokens = (testClient as any).estimatePromptTokens([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' }
]);
assert.ok(promptTokens > 0, 'Prompt tokens should be estimated to a non-zero value');
const completionTokens = (testClient as any).estimateCompletionTokens({
    role: 'assistant',
    content: 'test message content here'
});
assert.ok(completionTokens > 0, 'Completion tokens should be estimated to a non-zero value');
console.log(' -> LLMClient Token Estimation test passed.');


console.log('\n[Test 14]: Evaluating AgentLoop Stats Tracking and Grand Summary...');
const mockLLMForStats = {
    getModelName: () => 'mock-model',
    generateCompletion: async (messages: any[], tools: any[], onChunk: any) => {
        return {
            role: 'assistant',
            content: 'Task completed successfully.',
            usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                duration_ms: 1200,
                tok_sec: 41.67
            }
        };
    }
} as any;

const mockCoordinator = {
    getSessions: () => new Map(),
    getAllStates: () => ({}),
    getTopology: () => ({ nodes: [], links: [] }),
    discoverTopology: async () => {}
} as any;

const agentLoopForStats = new CiscoAgentLoop(mockLLMForStats, mockCoordinator);
agentLoopForStats.run('Simple mock goal').then(() => {
    console.log(' -> AgentLoop Stats Tracking test passed.');
}).catch((err) => {
    console.error(' -> AgentLoop Stats Tracking test FAILED:', err);
    process.exit(1);
});


console.log('\n[Test 12]: Evaluating PlinkSerialSession listAvailableComPorts...');
PlinkSerialSession.listAvailableComPorts().then(async (ports) => {
    assert.ok(Array.isArray(ports), 'COM ports query should return an array');
    console.log(` -> PlinkSerialSession COM ports query passed. Detected: ${ports.join(', ')}`);

    try {
        console.log('\n[Test 15]: Evaluating Alternating Sequence Loop Detection in AgentLoop...');
        const mockCallA = {
            id: 'call-a',
            type: 'function' as const,
            function: {
                name: 'execute_ios_command',
                arguments: JSON.stringify({ command: 'show ip route', device: 'iosv-0' })
            }
        };
        const mockCallB = {
            id: 'call-b',
            type: 'function' as const,
            function: {
                name: 'execute_ios_command',
                arguments: JSON.stringify({ command: 'show ip ospf neighbor', device: 'iosv-0' })
            }
        };
        
        const mockSessionInstance = {
            getState: () => ({ currentMode: 'PRIVILEGED_EXEC', hostname: 'iosv-0', prompt: 'iosv-0#' }),
            execute: async () => 'OK'
        } as any;
        const coordinatorForLoop = {
            getSessions: () => new Map([['iosv-0', mockSessionInstance]]),
            getSession: () => mockSessionInstance,
            getTopology: () => ({ discoveredAt: new Date().toISOString(), nodes: [], links: [] }),
            getAllStates: () => ({ 'iosv-0': mockSessionInstance.getState() })
        } as any;
        
        const loopForSeq = new CiscoAgentLoop({} as any, coordinatorForLoop);
        
        await (loopForSeq as any).handleExecuteCommandCall(mockCallA);
        await (loopForSeq as any).handleExecuteCommandCall(mockCallB);
        await (loopForSeq as any).handleExecuteCommandCall(mockCallA);
        await (loopForSeq as any).handleExecuteCommandCall(mockCallB);
        await (loopForSeq as any).handleExecuteCommandCall(mockCallA);
        
        let messages = (loopForSeq as any).messages;
        let loopBlock = messages.find((m: any) => m.role === 'tool' && m.content.includes('Loop check block'));
        assert.strictEqual(loopBlock, undefined, 'Alternating 5 times should not block yet');
        
        await (loopForSeq as any).handleExecuteCommandCall(mockCallB);
        messages = (loopForSeq as any).messages;
        loopBlock = messages.find((m: any) => m.role === 'tool' && m.content.includes('Loop check block'));
        assert.ok(loopBlock !== undefined, 'Alternating 6 times (3 complete repetitions) should trigger loop check block');
        console.log(' -> Alternating Sequence Loop Detection test passed.');

        console.log('\n[Test 16]: Evaluating ShellSimulator new features (OSPF, IP Routing, Flash/Backup)...');
        const { ShellSimulator } = require('../server/shell-simulator');
        const sim = new ShellSimulator();
        
        let routeOut = sim.execute('show ip route');
        assert.ok(!routeOut.includes('% IP routing table is not enabled'), 'Routing should be enabled by default');
        
        sim.execute('configure terminal');
        sim.execute('no ip routing');
        sim.execute('end');
        routeOut = sim.execute('show ip route');
        assert.ok(routeOut.includes('% IP routing table is not enabled'), 'no ip routing should disable routing table show');
        
        sim.execute('configure terminal');
        sim.execute('ip routing');
        sim.execute('end');
        
        let ospfOut = sim.execute('show ip ospf neighbor');
        assert.ok(ospfOut.includes('% OSPF is not enabled'), 'OSPF should not be enabled initially');
        
        sim.execute('configure terminal');
        sim.execute('router ospf 10');
        sim.execute('end');
        
        ospfOut = sim.execute('show ip ospf neighbor');
        assert.ok(ospfOut.includes('Neighbor ID') && ospfOut.includes('2.2.2.2'), 'OSPF neighbor table should show after enabling OSPF');
        
        let dirOut = sim.execute('dir flash:');
        assert.ok(!dirOut.includes('backup-agent.cfg'), 'backup-agent.cfg should not exist initially');
        
        let copyOut = sim.execute('copy running-config flash:backup-agent.cfg');
        assert.ok(copyOut.includes('Destination filename'), 'Should prompt for destination filename');
        
        let confirmOut = sim.execute('');
        assert.ok(confirmOut.includes('copied') || confirmOut.includes('OK'), 'Should complete copy operation');
        
        dirOut = sim.execute('dir flash:');
        assert.ok(dirOut.includes('backup-agent.cfg'), 'backup-agent.cfg should exist after copy');
        
        sim.execute('configure terminal');
        sim.execute('hostname NewHostname');
        assert.strictEqual(sim.hostname, 'NewHostname');
        sim.execute('end');
        
        let rollbackOut = sim.execute('configure replace flash:backup-agent.cfg force');
        assert.ok(rollbackOut.includes('Rollback Done'), 'Should rollback configuration successfully');
        assert.strictEqual(sim.hostname, 'Switch1', 'Hostname should revert to Switch1 after configuration replace');
        
        console.log(' -> ShellSimulator new features test passed.');

        console.log('\nAll Unit Tests Finished Successfully!');
    } catch (e: any) {
        console.error('New features test FAILED:', e.stack || e.message);
        process.exit(1);
    }
}).catch((err) => {
    console.error(' -> PlinkSerialSession COM ports query failed:', err);
    process.exit(1);
});
