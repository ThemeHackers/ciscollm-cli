import { SshSession } from '../src/infrastructure/protocols/SshSession';
import { TelnetSession } from '../src/infrastructure/protocols/TelnetSession';
import { NetconfSession } from '../src/infrastructure/protocols/NetconfSession';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import * as assert from 'assert';
import axios from 'axios';

async function verifySsh() {
    console.log('[Verification] Testing SSH connection...');
    const session = new SshSession({
        host: '127.0.0.1',
        port: 2222,
        username: 'admin',
        password: 'admin'
    });

    await session.connect();
    console.log('[Verification] SSH Connected. Current Mode:', session.getState().currentMode);
    assert.strictEqual(session.getState().currentMode, 'PRIVILEGED_EXEC');

    // Test execute command
    const versionOutput = await session.execute('show version');
    console.log('[Debug SSH Output]:', JSON.stringify(versionOutput));
    assert.ok(versionOutput.includes('Cisco IOS Software'), 'SSH show version output should contain Cisco IOS');

    // Test config mode transition
    await session.execute('configure terminal');
    assert.strictEqual(session.getState().currentMode, 'GLOBAL_CONFIG');

    // Test changing hostname
    await session.execute('hostname Switch-Test-SSH');
    assert.strictEqual(session.getState().hostname, 'Switch-Test-SSH');

    // Test interface configuration
    await session.execute('interface GigabitEthernet0/1');
    assert.strictEqual(session.getState().currentMode, 'INTERFACE_CONFIG');
    await session.execute('no shutdown');
    await session.execute('ip address 10.0.0.1 255.255.255.0');
    await session.execute('end');

    // Check configuration changes in show run
    const runningConfig = await session.execute('show running-config');
    assert.ok(runningConfig.includes('hostname Switch-Test-SSH'), 'Running config should show updated hostname');
    assert.ok(runningConfig.includes('ip address 10.0.0.1 255.255.255.0'), 'Running config should show updated interface IP');

    await session.disconnect();
    console.log('[Verification] SSH Connection test passed.');
}

async function verifyTelnet() {
    console.log('\n[Verification] Testing Telnet connection...');
    const session = new TelnetSession({
        host: '127.0.0.1',
        port: 2323,
        username: 'admin',
        password: 'admin'
    });

    await session.connect();
    console.log('[Verification] Telnet Connected. Current Mode:', session.getState().currentMode);
    assert.strictEqual(session.getState().currentMode, 'PRIVILEGED_EXEC');

    // Test execute command
    const versionOutput = await session.execute('show version');
    assert.ok(versionOutput.includes('Cisco IOS Software'), 'Telnet show version output should contain Cisco IOS');

    // Test config mode transition
    await session.execute('configure terminal');
    assert.strictEqual(session.getState().currentMode, 'GLOBAL_CONFIG');

    // Test interface configuration
    await session.execute('interface GigabitEthernet0/2');
    assert.strictEqual(session.getState().currentMode, 'INTERFACE_CONFIG');
    await session.execute('no shutdown');
    await session.execute('ip address 20.0.0.1 255.255.255.0');
    await session.execute('end');

    // Check configuration changes in show run
    const runningConfig = await session.execute('show running-config');
    assert.ok(runningConfig.includes('ip address 20.0.0.1 255.255.255.0'), 'Running config should show updated interface IP');

    await session.disconnect();
    console.log('[Verification] Telnet Connection test passed.');
}

async function verifyNetconf() {
    console.log('\n[Verification] Testing NETCONF connection...');
    const session = new NetconfSession('127.0.0.1', 2222, {
        username: 'admin',
        password: 'admin'
    });

    await session.connect();
    console.log('[Verification] NETCONF Handshake Completed.');

    // Build edit-config RPC request
    const editRpc = session.buildRpcRequest({
        target: 'running',
        config: {
            native: {
                hostname: 'Switch-Test-NETCONF'
            }
        },
        messageId: 'netconf-id-123'
    });

    // Execute RPC
    const replyXml = await session.execute(editRpc);
    assert.ok(replyXml.includes('<ok/>'), 'NETCONF reply should contain <ok/>');

    await session.disconnect();
    console.log('[Verification] NETCONF Connection test passed.');
}

async function verifyHttp() {
    console.log('\n[Verification] Testing HTTP LLM endpoints...');
    
    // Find the correct mock server port
    let actualPort = 11434;
    for (let p = 11434; p <= 11440; p++) {
        try {
            const res = await axios.get(`http://127.0.0.1:${p}/api/v1/models`, { timeout: 1000 });
            if (res.status === 200) {
                actualPort = p;
                break;
            }
        } catch {
            // keep trying
        }
    }
    
    console.log(`[Verification] Detected mock HTTP server running on port ${actualPort}`);
    const client = new LLMClient('local', `http://127.0.0.1:${actualPort}/v1`, 'qwen3.5:4b');

    // First preflight reachability
    await client.ensureReachable();
    console.log('[Verification] HTTP preflight endpoint is reachable.');

    // Trigger setupModelIfNeeded. It should download because qwen3.5:4b is not in the mock server's models initially.
    console.log('[Verification] Running model setup (should trigger download)...');
    let progressUpdates: string[] = [];
    await client.setupModelIfNeeded((status) => {
        progressUpdates.push(status);
        console.log('   ->', status);
    });

    // Check that we got download progress updates
    assert.ok(progressUpdates.some(u => u.includes('Triggering download') || u.includes('Downloading')), 'Should have triggered download flow');
    assert.ok(progressUpdates.some(u => u.includes('loaded')), 'Should have loaded the model');

    // Running model setup again. It should be instant because model is already present
    console.log('[Verification] Running model setup again (should skip download)...');
    progressUpdates = [];
    await client.setupModelIfNeeded((status) => {
        progressUpdates.push(status);
        console.log('   ->', status);
    });
    
    assert.ok(!progressUpdates.some(u => u.includes('Triggering download')), 'Second run should not trigger download');

    // Test completions (standard non-streaming)
    console.log('[Verification] Testing non-streaming completion...');
    const completion = await client.generateCompletion([{ role: 'user', content: 'hello' }], []);
    console.log('[Verification] Completion Response:', JSON.stringify(completion));
    assert.ok(completion.content.includes('Hello'), 'Completion response should contain Hello');

    console.log('[Verification] HTTP LLM tests passed.');
}

async function main() {
    try {
        await verifySsh();
        await verifyTelnet();
        await verifyNetconf();
        await verifyHttp();
        console.log('\nAll connection verifications passed successfully!');
        process.exit(0);
    } catch (e: any) {
        console.error('\nVerification FAILED:', e.stack || e.message);
        process.exit(1);
    }
}

main();
