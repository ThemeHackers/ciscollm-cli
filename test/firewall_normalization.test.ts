import { CommandFirewall } from '../src/core/guardrails/CommandFirewall';
import * as assert from 'assert';

function testNormalization() {
    console.log('Testing Command Normalization...');

    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('conf t'), 'configure terminal');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('configure t'), 'configure terminal');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('int gi0/1'), 'interface gigabitethernet0/1');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('shut'), 'shutdown');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('no shut'), 'no shutdown');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('no ip add'), 'no ip address');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('no ip addr'), 'no ip address');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('crypto key zero'), 'crypto key zeroize');
    assert.strictEqual(CommandFirewall.normalizeCiscoCommand('no aaa new'), 'no aaa new-model');

    console.log(' -> Normalization tests passed.');
}

function testFirewallCheck() {
    console.log('Testing Firewall Block with Abbreviated Commands...');

    
    const firewall = new CommandFirewall(['GigabitEthernet0/1']);

    
    const r1 = firewall.checkCommand('shut', 'GigabitEthernet0/1');
   
    assert.ok(r1.dangerous, 'Should block abbreviated "shut" on protected interface');
    assert.ok(r1.reason?.includes('shutdown'), 'Reason should mention shutdown');

    const r2 = firewall.checkCommand('no ip add', 'GigabitEthernet0/1');
    assert.ok(r2.dangerous, 'Should block abbreviated "no ip add" on protected interface');
    assert.ok(r2.reason?.includes('IP address'), 'Reason should mention IP address');

    const r3 = firewall.checkCommand('no aaa new', null);
    assert.ok(r3.dangerous, 'Should block abbreviated "no aaa new"');

    const r4 = firewall.checkCommand('crypto key zero', null);
    assert.ok(r4.dangerous, 'Should block abbreviated "crypto key zero"');

    console.log(' -> Firewall block tests passed.');
}

try {
    testNormalization();
    testFirewallCheck();
    console.log('All CommandFirewall unit tests passed successfully!');
    process.exit(0);
} catch (e: any) {
    console.error('Test FAILED:', e.message || e);
    process.exit(1);
}
