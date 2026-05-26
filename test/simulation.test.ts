import { MockSession } from '../src/infrastructure/protocols/MockSession';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import { ErrorAnalyzer } from '../src/core/guardrails/ErrorAnalyzer';
import { CiscoAgentLoop } from '../src/core/agent/AgentLoop';
import { TransactionManager } from '../src/core/rollback/TransactionManager';
import * as assert from 'assert';

console.log('Running offline Cisco Switch simulation test suite...\n');

async function runSimulationTests() {
    const coordinator = new MultiAgentCoordinator();
    const mockSwitch = new MockSession('Switch1');
    coordinator.registerSession('Switch1', mockSwitch);


    console.log('[Test 1]: Establishing mock connection...');
    await coordinator.connectAll();
    const initialState = mockSwitch.getState();
    assert.strictEqual(initialState.currentMode, 'USER_EXEC', 'Initial mode must be USER_EXEC');
    assert.strictEqual(initialState.prompt, 'Switch1>', 'Initial prompt must be Switch1>');
    console.log(' -> Connection test passed.');


    console.log('\n[Test 2]: Simulating Cisco IOS navigation...');
    

    await mockSwitch.execute('enable');
    assert.strictEqual(mockSwitch.getState().currentMode, 'PRIVILEGED_EXEC');
    assert.strictEqual(mockSwitch.getState().prompt, 'Switch1#');


    const confTermOut = await mockSwitch.execute('config t');
    assert.ok(confTermOut.includes('Enter configuration commands'), 'Should output config message');
    assert.strictEqual(mockSwitch.getState().currentMode, 'GLOBAL_CONFIG');
    assert.strictEqual(mockSwitch.getState().prompt, 'Switch1(config)#');


    const badIntf = await mockSwitch.execute('interface gi9/9');
    assert.ok(badIntf.includes('^'), 'Invalid interface command should include caret marker');
    assert.ok(badIntf.includes('Bad interface parameter'), 'Invalid interface command should report bad interface parameter');


    await mockSwitch.execute('int gi0/1');
    assert.strictEqual(mockSwitch.getState().currentMode, 'INTERFACE_CONFIG');
    assert.strictEqual(mockSwitch.getState().prompt, 'Switch1(config-if)#');
    console.log(' -> Navigation test passed.');


    console.log('\n[Test 3]: Simulating interface configuration...');
    
   
    await mockSwitch.execute('ip add 10.0.1.1 255.255.255.0');
    
  
    await mockSwitch.execute('no shutdown');

    await mockSwitch.execute('description Simulated LAN Interface');


    const runConfig = await mockSwitch.execute('show running-config');
    assert.ok(runConfig.includes('interface GigabitEthernet0/1'), 'Config must contain interface block');
    assert.ok(runConfig.includes('ip address 10.0.1.1 255.255.255.0'), 'Config must show IP');
    assert.ok(runConfig.includes('description Simulated LAN Interface'), 'Config must show description');
    
    const gig1Index = runConfig.indexOf('interface GigabitEthernet0/1');
    const gig1Block = runConfig.substring(gig1Index, runConfig.indexOf('!', gig1Index));
    assert.ok(!gig1Block.includes('shutdown'), 'Shutdown statement must not exist for gig0/1');
    console.log(' -> Configuration mutation test passed.');


    console.log('\n[Test 4]: Simulating ping verification and command outputs...');
    

    const ipBrief = await mockSwitch.execute('show ip interface brief');
    assert.ok(ipBrief.includes('GigabitEthernet0/1'), 'Brief must list gig0/1');
    assert.ok(ipBrief.includes('10.0.1.1'), 'Brief must show configured IP');


    const pingSuccess = await mockSwitch.execute('ping 10.0.1.1');
    assert.ok(pingSuccess.includes('!!!!!'), 'Ping output must indicate success');
    assert.ok(pingSuccess.includes('100 percent'), 'Ping success rate must be 100 percent');

    const pingSubnetSuccess = await mockSwitch.execute('ping 10.0.1.2');
    assert.ok(pingSubnetSuccess.includes('!!!!!'), 'Ping to a host on the connected subnet must succeed');
    assert.ok(pingSubnetSuccess.includes('100 percent'), 'Subnet ping success rate must be 100 percent');

    const pingFail = await mockSwitch.execute('ping 10.0.2.2');
    assert.ok(pingFail.includes('.....'), 'Ping output must indicate packet loss');
    assert.ok(pingFail.includes('0 percent'), 'Ping success rate must be 0 percent');

    const routeTable = await mockSwitch.execute('show ip route');
    assert.ok(routeTable.includes('C 10.0.1.0'), 'Route table must include the connected subnet');
    console.log(' -> Ping and verification test passed.');


    console.log('\n[Test 5]: Simulating command errors...');
    const errOutput = await mockSwitch.execute('ip addresss 1.1.1.1 255.255.255.0');
    assert.ok(errOutput.includes('^'), 'Must return a caret marker for the syntax error');
    assert.ok(errOutput.includes('Invalid input'), 'Must return invalid input error text');
    
    const analysis = ErrorAnalyzer.checkOutput(errOutput);
    assert.strictEqual(analysis.hasError, true, 'Error analyzer must catch the warning');
    console.log(' -> Error simulation passed.');

    console.log('\n[Test 6]: Simulating Cisco IOS Shell (IOS.sh)...');
    await mockSwitch.execute('end');
    await mockSwitch.execute('terminal shell');
    
    await mockSwitch.execute('TEST_VAR=192.168.1.254');
    const echoOut = await mockSwitch.execute('echo $TEST_VAR');
    assert.strictEqual(echoOut, '192.168.1.254', 'Variable substitution must return the assigned value');
    
    const pingVarOut = await mockSwitch.execute('ping $TEST_VAR');
    assert.ok(pingVarOut.includes('Success rate is 100 percent'), 'Ping with variable must execute successfully');
    
    const runConfigFiltered = await mockSwitch.execute('show running-config | include GigabitEthernet0/1');
    assert.ok(runConfigFiltered.includes('interface GigabitEthernet0/1'), 'Piping include filter must match line');
    assert.ok(!runConfigFiltered.includes('GigabitEthernet0/2'), 'Piping include filter must exclude unmatched lines');
    
    const loopOut = await mockSwitch.execute('for i in foo bar; do echo $i; done');
    assert.ok(loopOut.includes('foo') && loopOut.includes('bar'), 'Loop output must contain both values');
    
    await mockSwitch.execute('hello_func() { echo hello; }');
    const funcOut = await mockSwitch.execute('hello_func');
    assert.strictEqual(funcOut, 'hello', 'Executing defined shell function must run its body');
    
    const envOut = await mockSwitch.execute('show shell environment');
    assert.ok(envOut.includes('TEST_VAR=192.168.1.254'), 'Show environment must list defined variables');
    
    const funcListOut = await mockSwitch.execute('show shell functions');
    assert.ok(funcListOut.includes('hello_func() { echo hello; }'), 'Show functions must list defined functions');
    
    console.log(' -> IOS Shell simulation passed.');

    console.log('\n[Test 7b]: Simulating transaction rollback via mock snapshots...');
    const transactionManager = new TransactionManager();
    await transactionManager.initializeBackup(mockSwitch);

    await mockSwitch.execute('end');
    await mockSwitch.execute('enable');
    await mockSwitch.execute('configure terminal');
    await mockSwitch.execute('interface gigabitEthernet0/1');
    await mockSwitch.execute('ip address 10.0.9.1 255.255.255.0');
    await mockSwitch.execute('no shutdown');
    await mockSwitch.execute('end');

    const rollbackOutput = await transactionManager.executeRollback(mockSwitch);
    assert.ok(rollbackOutput.includes('Mock backup restore completed successfully'), 'Rollback should use backup snapshot restore on mock sessions');

    const postRollbackBrief = await mockSwitch.execute('show ip interface brief');
    assert.ok(!postRollbackBrief.includes('10.0.9.1'), 'Rollback must remove the temporary address change');
    console.log(' -> Transaction rollback simulation passed.');

    console.log('\n[Test 7]: Simulating Agent Loop Tool Call handlers...');
    const agent = new CiscoAgentLoop(null as any, coordinator);
    
    const enableCall = {
        id: 'call_enable',
        type: 'function' as const,
        function: {
            name: 'enable_ios_shell',
            arguments: JSON.stringify({ mode: 'session', device: 'Switch1' })
        }
    };
    await (agent as any).handleEnableIosShellCall(enableCall);
    
    const varCall = {
        id: 'call_var',
        type: 'function' as const,
        function: {
            name: 'define_shell_variable',
            arguments: JSON.stringify({ name: 'AGENT_VAR', value: 'hello_agent', device: 'Switch1' })
        }
    };
    await (agent as any).handleDefineShellVariableCall(varCall);
    
    const verifyVar = await mockSwitch.execute('echo $AGENT_VAR');
    assert.strictEqual(verifyVar, 'hello_agent', 'Agent loop define_shell_variable tool must successfully set variable');

    const loopCall = {
        id: 'call_loop',
        type: 'function' as const,
        function: {
            name: 'execute_shell_loop',
            arguments: JSON.stringify({ variable: 'x', items: ['apple', 'banana'], command: 'echo $x', device: 'Switch1' })
        }
    };
    await (agent as any).handleExecuteShellLoopCall(loopCall);

    const funcCall = {
        id: 'call_func',
        type: 'function' as const,
        function: {
            name: 'define_shell_function',
            arguments: JSON.stringify({ name: 'agent_func', body: 'echo func_worked', device: 'Switch1' })
        }
    };
    await (agent as any).handleDefineShellFunctionCall(funcCall);
    const verifyFunc = await mockSwitch.execute('agent_func');
    assert.strictEqual(verifyFunc, 'func_worked', 'Agent loop define_shell_function tool must successfully define function');

    console.log(' -> Agent Loop Tool Calls simulation passed.');

    console.log('\n[Test 8]: Simulating Dynamic Tool Selection and Consecutive Loop Check...');
    
   
    const mockSwitch2 = new MockSession('Switch2');
    assert.strictEqual(mockSwitch2.isShellEnabled(), false, 'Shell must be disabled initially');
    

    await mockSwitch2.execute('enable');
    await mockSwitch2.execute('terminal shell');
    assert.strictEqual(mockSwitch2.isShellEnabled(), true, 'Shell must be enabled after terminal shell command');
    
  
    const coordinator2 = new MultiAgentCoordinator();
    coordinator2.registerSession('Switch2', mockSwitch2);
    
    const filterTools = (shellEnabled: boolean) => {
        const { CiscoAgentTools } = require('../src/infrastructure/llm/ToolDefinitions');
        return CiscoAgentTools.filter((tool: any) => {
            const shellTools = ['define_shell_variable', 'execute_shell_loop', 'define_shell_function'];
            if (shellTools.includes(tool.function.name)) {
                return shellEnabled;
            }
            return true;
        });
    };
    
    const toolsWithShell = filterTools(true);
    assert.strictEqual(toolsWithShell.length, 6, 'Should include all 6 tools when shell is enabled');
    
    const toolsWithoutShell = filterTools(false);
    assert.strictEqual(toolsWithoutShell.length, 3, 'Should include only 3 tools when shell is disabled');
    assert.ok(toolsWithoutShell.some((t: any) => t.function.name === 'execute_ios_command'));
    assert.ok(!toolsWithoutShell.some((t: any) => t.function.name === 'define_shell_variable'));


    const agent3 = new CiscoAgentLoop(null as any, coordinator2);
    
    const executeCall = (cmd: string) => {
        return {
            id: 'call_cmd',
            type: 'function' as const,
            function: {
                name: 'execute_ios_command',
                arguments: JSON.stringify({ command: cmd, device: 'Switch2' })
            }
        };
    };
    
  
    await (agent3 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    await (agent3 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    await (agent3 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    
    const history3 = (agent3 as any).messages;
    assert.ok(history3.some((m: any) => m.role === 'tool' && m.content.includes('Interface')), 'Previous show ip interface brief commands should execute successfully');
    
  
    await (agent3 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    const finalHistory = (agent3 as any).messages;
    const lastResponse = finalHistory[finalHistory.length - 1];
    assert.strictEqual(lastResponse.role, 'tool', 'Last response should be tool response');
    assert.ok(lastResponse.content.includes('CRITICAL ERROR: Loop check block'), 'Should return Loop check block error on 4th consecutive execution');
    
  
    const agent4 = new CiscoAgentLoop(null as any, coordinator2);
    await (agent4 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    await (agent4 as any).handleExecuteCommandCall(executeCall('ping 127.0.0.1'));
    await (agent4 as any).handleExecuteCommandCall(executeCall('show ip interface brief'));
    await (agent4 as any).handleExecuteCommandCall(executeCall('ping 127.0.0.1'));
    
    const history4 = (agent4 as any).messages;
    const hasLoopError = history4.some((m: any) => m.role === 'tool' && m.content.includes('Loop check block'));
    assert.strictEqual(hasLoopError, false, 'Alternating commands should NOT trigger loop check block');
    
    console.log(' -> Dynamic Tool Selection and Consecutive Loop Check passed.');

    console.log('\nCisco Switch simulation test suite completed successfully!');
}

runSimulationTests().catch(err => {
    console.error('Simulation test suite FAILED:', err);
    process.exit(1);
});
