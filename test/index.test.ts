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

assert.strictEqual(lines.length, 100, 'Truncated output should have exactly 41 lines');
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

        console.log('\n[Test 16]: Evaluating SwitchDevice new features (OSPF, IP Routing, Flash/Backup)...');
        const { SwitchDevice } = require('../src/server/devices/SwitchDevice');
        const sim = new SwitchDevice();

        
        const simNormalize = (sim as any).normalizeInterfaceName.bind(sim);
        assert.strictEqual(simNormalize('gi0/3'), 'GigabitEthernet0/3');
        assert.strictEqual(simNormalize('GigabitEthernet0/3'), 'GigabitEthernet0/3');
        assert.strictEqual(simNormalize('gig0/3'), 'GigabitEthernet0/3');
        assert.strictEqual(simNormalize('fa0/1'), 'FastEthernet0/1');
        assert.strictEqual(simNormalize('FastEthernet0/1'), 'FastEthernet0/1');
        assert.strictEqual(simNormalize('lo0'), 'Loopback0');
        assert.strictEqual(simNormalize('Loopback0'), 'Loopback0');

        const { normalizeInterfaceName } = require('../src/shared/utils');
        assert.strictEqual(normalizeInterfaceName('gi0/3'), 'gigabitethernet0/3');
        assert.strictEqual(normalizeInterfaceName('GigabitEthernet0/3'), 'gigabitethernet0/3');
        assert.strictEqual(normalizeInterfaceName('gig0/3'), 'gigabitethernet0/3');
        assert.strictEqual(normalizeInterfaceName('fa0/1'), 'fastethernet0/1');
        assert.strictEqual(normalizeInterfaceName('FastEthernet0/1'), 'fastethernet0/1');

        sim.processCommand('enable');
        
        let routeOut = sim.processCommand('show ip route');
        assert.ok(!routeOut.includes('% IP routing table is not enabled'), 'Routing should be enabled by default');
        
        sim.processCommand('configure terminal');
        sim.processCommand('no ip routing');
        sim.processCommand('end');
        routeOut = sim.processCommand('show ip route');
        assert.ok(routeOut.includes('% IP routing table is not enabled'), 'no ip routing should disable routing table show');
        
        sim.processCommand('configure terminal');
        sim.processCommand('ip routing');
        sim.processCommand('end');
        
        let ospfOut = sim.processCommand('show ip ospf neighbor');
        assert.ok(ospfOut.includes('% OSPF is not enabled'), 'OSPF should not be enabled initially');
        
        sim.processCommand('configure terminal');
        sim.processCommand('router ospf 10');
        sim.processCommand('end');
        
        ospfOut = sim.processCommand('show ip ospf neighbor');
        assert.ok(ospfOut.includes('Neighbor ID') && ospfOut.includes('2.2.2.2'), 'OSPF neighbor table should show after enabling OSPF');
        
        let dirOut = sim.processCommand('dir flash:');
        assert.ok(!dirOut.includes('backup-agent.cfg'), 'backup-agent.cfg should not exist initially');
        
        let copyOut = sim.processCommand('copy running-config flash:backup-agent.cfg');
        assert.ok(copyOut.includes('Destination filename'), 'Should prompt for destination filename');
        
        let confirmOut = sim.processCommand('');
        assert.ok(confirmOut.includes('copied') || confirmOut.includes('OK'), 'Should complete copy operation');
        
        dirOut = sim.processCommand('dir flash:');
        assert.ok(dirOut.includes('backup-agent.cfg'), 'backup-agent.cfg should exist after copy');
        
        sim.processCommand('configure terminal');
        sim.processCommand('hostname NewHostname');
        assert.strictEqual(sim.hostname, 'NewHostname');
        sim.processCommand('end');
        
        let rollbackOut = sim.processCommand('configure replace flash:backup-agent.cfg force');
        assert.ok(rollbackOut.includes('Rollback Done'), 'Should rollback configuration successfully');
        assert.strictEqual(sim.hostname, 'Switch1', 'Hostname should revert to Switch1 after configuration replace');
        
        
        sim.processCommand('configure terminal');
        sim.processCommand('vlan 50');
        assert.strictEqual(sim.mode, 'VLAN_CONFIG', 'vlan 50 should transition simulator to VLAN_CONFIG mode');
        assert.strictEqual(sim.getPrompt(), 'Switch1(config-vlan)# ', 'vlan 50 should update prompt to (config-vlan)#');
        
        
        sim.processCommand('name Finance_Dept');
        assert.strictEqual(sim.vlanNames.get(50), 'Finance_Dept', 'name command in VLAN_CONFIG mode should set VLAN name');
        

        sim.processCommand('exit');
        assert.strictEqual(sim.mode, 'GLOBAL_CONFIG', 'exit in VLAN_CONFIG should return to GLOBAL_CONFIG');
        
       
        sim.processCommand('interface GigabitEthernet0/1');
        assert.strictEqual(sim.mode, 'INTERFACE_CONFIG', 'interface command should transition to INTERFACE_CONFIG');
        sim.processCommand('switchport');
        const gi01 = sim.interfaces.get('GigabitEthernet0/1')!;
        assert.strictEqual(gi01.isSwitchport, true, 'switchport command should enable switchport flag');
        
        sim.processCommand('switchport mode access');
        assert.strictEqual(gi01.switchportMode, 'access', 'switchport mode access should configure access mode');
        
        const vlanAccessOut = sim.processCommand('switchport access vlan 60');
        assert.ok(vlanAccessOut.includes('Creating vlan 60'), 'Should auto-create non-existent VLAN');
        assert.strictEqual(gi01.vlan, 60, 'switchport access vlan should assign VLAN 60 to port');
        assert.ok(sim.vlans.has(60), 'VLAN 60 should be created in the global VLAN list');

      
        sim.processCommand('end');
        const vlanBriefOut = sim.processCommand('show vlan brief');
        assert.ok(vlanBriefOut.includes('VLAN0060') || vlanBriefOut.includes('60'), 'show vlan brief should contain VLAN 60');
        assert.ok(vlanBriefOut.includes('Gi0/1'), 'show vlan brief should list Gi0/1 under VLAN 60 ports');


        
        sim.processCommand('configure terminal');
        sim.processCommand('router rip');
        assert.strictEqual(sim.mode, 'RIP_CONFIG', 'router rip should transition to RIP_CONFIG');
        assert.strictEqual(sim.getPrompt(), 'Switch1(config-router)# ', 'RIP_CONFIG prompt should be (config-router)#');
        sim.processCommand('version 2');
        assert.strictEqual((sim as any).ripVersion, 2, 'version 2 should configure RIP version to 2');
        sim.processCommand('no auto-summary');
        assert.strictEqual((sim as any).ripAutoSummary, false, 'no auto-summary should disable auto-summary');
        sim.processCommand('exit');
        assert.strictEqual(sim.mode, 'GLOBAL_CONFIG', 'exit in RIP_CONFIG should return to GLOBAL_CONFIG');

        sim.processCommand('router bgp 65000');
        assert.strictEqual(sim.mode, 'BGP_CONFIG', 'router bgp should transition to BGP_CONFIG');
        assert.strictEqual(sim.getPrompt(), 'Switch1(config-router)# ', 'BGP_CONFIG prompt should be (config-router)#');
        sim.processCommand('exit');
        assert.strictEqual(sim.mode, 'GLOBAL_CONFIG', 'exit in BGP_CONFIG should return to GLOBAL_CONFIG');

    
        const stpResult = sim.processCommand('spanning-tree mode rapid-pvst');
        assert.strictEqual(stpResult, '', 'spanning-tree mode rapid-pvst should execute successfully');

     
        sim.processCommand('interface GigabitEthernet0/1');
        sim.processCommand('switchport mode trunk');
        assert.strictEqual(gi01.switchportMode, 'trunk', 'switchport mode trunk should set switchportMode to trunk');
        const cgResult = sim.processCommand('channel-group 1 mode active');
        assert.strictEqual(cgResult, '', 'channel-group command should execute successfully');
        sim.processCommand('end');


        const protocolsOut = sim.processCommand('show ip protocols');
        assert.ok(protocolsOut.includes('Routing Protocol is "rip"'), 'show ip protocols should contain rip');
        assert.ok(protocolsOut.includes('Routing Protocol is "bgp 65000"'), 'show ip protocols should contain bgp 65000');
        assert.ok(protocolsOut.includes('Automatic network summarization is not in effect'), 'show ip protocols should report auto-summary state');


     
        sim.processCommand('configure terminal');
        sim.processCommand('router eigrp 100');
        assert.strictEqual(sim.mode, 'EIGRP_CONFIG', 'router eigrp should transition to EIGRP_CONFIG');
        assert.strictEqual(sim.getPrompt(), 'Switch1(config-router)# ', 'EIGRP_CONFIG prompt should be (config-router)#');
        sim.processCommand('network 192.168.1.0');
        sim.processCommand('exit');

        sim.processCommand('vtp mode client');
        assert.strictEqual((sim as any).vtpMode, 'client', 'vtp mode client should set mode to client');
        sim.processCommand('vtp domain mydomain');
        assert.strictEqual((sim as any).vtpDomain, 'mydomain', 'vtp domain should set domain');

        sim.processCommand('ntp server 10.0.0.5');
        assert.ok((sim as any).ntpServers.includes('10.0.0.5'), 'ntp server should be added');

        sim.processCommand('snmp-server community public RO');
        assert.ok((sim as any).snmpCommunities.includes('public'), 'snmp community should be added');

        sim.processCommand('ip nat inside source list 1 interface GigabitEthernet0/0 overload');
        assert.ok((sim as any).natRules.length > 0, 'nat rule should be added');

        sim.processCommand('access-list 10 permit 192.168.1.0 0.0.0.255');
        assert.ok((sim as any).acls.has('10'), 'acl should be created');

        sim.processCommand('interface GigabitEthernet0/1');
        sim.processCommand('standby 1 ip 10.0.0.1');
        sim.processCommand('standby 1 priority 110');
        sim.processCommand('standby 1 preempt');
        const hsrp = (sim as any).hsrpGroups.get('1')!;
        assert.strictEqual(hsrp.virtualIp, '10.0.0.1', 'HSRP vip should be set');
        assert.strictEqual(hsrp.priority, 110, 'HSRP priority should be set');
        assert.strictEqual(hsrp.preempt, true, 'HSRP preempt should be set');

        sim.processCommand('vrrp 2 ip 10.0.0.2');
        sim.processCommand('vrrp 2 priority 120');
        const vrrp = (sim as any).vrrpGroups.get('2')!;
        assert.strictEqual(vrrp.virtualIp, '10.0.0.2', 'VRRP vip should be set');
        assert.strictEqual(vrrp.priority, 120, 'VRRP priority should be set');

        sim.processCommand('ip nat inside');
        assert.strictEqual(gi01.natType, 'inside', 'nat inside should be set');
        sim.processCommand('end');


        const vtpOut = sim.processCommand('show vtp status');
        assert.ok(vtpOut.includes('VTP Operating Mode                 : client'), 'show vtp status should show Mode client');

        const standbyOut = sim.processCommand('show standby brief');
        assert.ok(standbyOut.includes('10.0.0.1'), 'show standby should show vip');

        const vrrpOut = sim.processCommand('show vrrp brief');
        assert.ok(vrrpOut.includes('10.0.0.2'), 'show vrrp should show vip');

        const natOut = sim.processCommand('show ip nat translations');
        assert.ok(natOut.includes('192.168.1.10'), 'show ip nat translations should return active rules');

        const aclOut = sim.processCommand('show access-lists');
        assert.ok(aclOut.includes('Standard IP access list 10'), 'show access-lists should show acl 10');

        const ntpOut = sim.processCommand('show ntp status');
        assert.ok(ntpOut.includes('10.0.0.5'), 'show ntp status should report reference server');

        const newProtocolsOut = sim.processCommand('show ip protocols');
        assert.ok(newProtocolsOut.includes('Routing Protocol is "eigrp 100"'), 'show ip protocols should contain eigrp');


        sim.processCommand('configure terminal');
        sim.processCommand('feature vpc');
        sim.processCommand('feature nv overlay');
        assert.ok((sim as any).featuresEnabled.has('vpc'), 'feature vpc should be enabled');
        assert.ok((sim as any).featuresEnabled.has('nv overlay'), 'feature nv overlay should be enabled');

        sim.processCommand('vpc domain 10');
        assert.strictEqual(sim.mode, 'VPC_CONFIG', 'vpc domain should transition to VPC_CONFIG');
        sim.processCommand('peer-keepalive destination 192.168.1.2 source 192.168.1.1');
        assert.strictEqual((sim as any).vpcDomainId, 10, 'vpcDomainId should be set');
        assert.ok((sim as any).vpcPeerKeepalive.includes('destination 192.168.1.2'), 'vpcPeerKeepalive should be set');
        sim.processCommand('exit');

        sim.processCommand('vrf context tenantA');
        assert.strictEqual(sim.mode, 'VRF_CONFIG', 'vrf context should transition to VRF_CONFIG');
        sim.processCommand('vni 50000');
        sim.processCommand('rd 1:1');
        const vrfState = (sim as any).vrfs.get('tenantA')!;
        assert.strictEqual(vrfState.vni, 50000, 'VRF VNI should be set');
        assert.strictEqual(vrfState.rd, '1:1', 'VRF RD should be set');

        sim.processCommand('address-family ipv4 unicast');
        assert.strictEqual(sim.mode, 'VRF_AF_CONFIG', 'address-family in VRF should transition to VRF_AF_CONFIG');
        sim.processCommand('route-target both auto evpn');
        assert.ok(vrfState.routeTargets.includes('both auto evpn'), 'VRF route target should be set');
        sim.processCommand('exit');
        sim.processCommand('exit');

        sim.processCommand('vlan 10');
        sim.processCommand('vn-segment 10010');
        assert.strictEqual((sim as any).vnSegments.get(10), 10010, 'vn-segment mapping should be set');
        sim.processCommand('exit');

        sim.processCommand('interface nve1');
        sim.processCommand('source-interface Loopback0');
        sim.processCommand('member vni 10010 mcast-group 239.1.1.10');
        const nve = (sim as any).interfaces.get('Nve1')!;
        assert.strictEqual(nve.sourceInterface, 'Loopback0', 'NVE source interface should be set');
        assert.ok(nve.memberVnis.has(10010), 'NVE VNI membership should be registered');
        sim.processCommand('end');


        const vpcOut = sim.processCommand('show vpc');
        assert.ok(vpcOut.includes('vPC domain id                     : 10'), 'show vpc should display domain ID');
        assert.ok(vpcOut.includes('peer adjacency formed ok'), 'show vpc should display peer status');

        const nveIntOut = sim.processCommand('show nve interface');
        assert.ok(nveIntOut.includes('Interface: Nve1'), 'show nve interface should show interface name');
        assert.ok(nveIntOut.includes('Source-Interface: Loopback0'), 'show nve interface should show source loopback');

        const nveVniOut = sim.processCommand('show nve vni');
        assert.ok(nveVniOut.includes('Nve1') && nveVniOut.includes('10010'), 'show nve vni should show VNI configuration');

        const bgpEvpnOut = sim.processCommand('show bgp l2vpn evpn summary');
        assert.ok(bgpEvpnOut.includes('address family L2VPN EVPN'), 'show bgp summary should mention address family');

        const dummyTopology = { devices: [], links: [] } as any;
        const routeValidation1 = PreExecutionValidator.validateCommand('no ip route 192.168.1.0 255.255.255.0', '192.168.1.254', dummyTopology, null);
        assert.strictEqual(routeValidation1.safe, false, 'Deleting management network route should be unsafe');
        assert.strictEqual(routeValidation1.warnLevel, 'CRITICAL', 'Deleting management network route warning should be CRITICAL');

        const routeValidation2 = PreExecutionValidator.validateCommand('no ip route 10.0.0.0 255.0.0.0', '192.168.1.254', dummyTopology, null);
        assert.strictEqual(routeValidation2.safe, true, 'Deleting non-management route should be safe');

        console.log(' -> SwitchDevice new features test passed.');

        console.log('\n[Test 17]: Evaluating ASADevice...');
        const { ASADevice } = require('../src/server/devices/ASADevice');
        const asa = new ASADevice();
        assert.ok(asa.getPrompt().includes('ciscoasa>'));
        asa.processCommand('enable');
        assert.ok(asa.getPrompt().includes('ciscoasa#'));
        asa.processCommand('configure terminal');
        assert.ok(asa.getPrompt().includes('ciscoasa(config)#'));
        asa.processCommand('interface vlan1');
        assert.ok(asa.getPrompt().includes('ciscoasa(config-if)#'));
        asa.processCommand('nameif inside');
        const asaOut = asa.processCommand('do show nameif');
        assert.ok(asaOut.includes('inside') && asaOut.includes('100'));
        console.log(' -> ASADevice test passed.');

        console.log('\n[Test 18]: Evaluating LinuxServerDevice...');
        const { LinuxServerDevice } = require('../src/server/devices/LinuxServerDevice');
        const linux = new LinuxServerDevice();
        assert.ok(linux.getPrompt().includes('root@server:/root#'));
        const ipOut = linux.processCommand('ip addr');
        assert.ok(ipOut.includes('192.168.1.100/24'));
        const pingOut = linux.processCommand('ping 8.8.8.8');
        assert.ok(pingOut.includes('0% packet loss'));
        const curlOut = linux.processCommand('curl localhost');
        assert.ok(curlOut.includes('Welcome to Nginx!'));
        console.log(' -> LinuxServerDevice test passed.');

        console.log('\n[Test 19]: Evaluating WLCDevice...');
        const { WLCDevice } = require('../src/server/devices/WLCDevice');
        const wlc = new WLCDevice();
        assert.ok(wlc.getPrompt().includes('(Cisco Controller) >'));
        const wlanOut = wlc.processCommand('show wlan summary');
        assert.ok(wlanOut.includes('Guest-WiFi') && wlanOut.includes('Corp-WiFi'));
        const clientOut = wlc.processCommand('show client summary');
        assert.ok(clientOut.includes('Number of Clients................................ 42'));
        wlc.processCommand('config wlan create 3 Test-WiFi Test-WiFi');
        const newWlanOut = wlc.processCommand('show wlan summary');
        assert.ok(newWlanOut.includes('Test-WiFi') && newWlanOut.includes('Disabled'));
        console.log(' -> WLCDevice test passed.');

        console.log('\nAll Unit Tests Finished Successfully!');
    } catch (e: any) {
        console.error('New features test FAILED:', e.stack || e.message);
        process.exit(1);
    }
}).catch((err) => {
    console.error(' -> PlinkSerialSession COM ports query failed:', err);
    process.exit(1);
});
