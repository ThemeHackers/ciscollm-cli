process.env.NODE_ENV = 'test';
import * as assert from 'assert';
import { ASADevice } from '../src/server/devices/ASADevice';
import { PromptEngine } from '../src/core/agent/PromptEngine';

console.log('Running ASA ACL tests...\n');

const asa = new ASADevice('ciscoasa');
assert.strictEqual(asa.processCommand('enable'), 'Password: \n', 'Should enter privileged mode');
assert.strictEqual(asa.processCommand('configure terminal'), '', 'Should enter global config mode');
assert.strictEqual(
    asa.processCommand('access-list OUTSIDE_IN extended permit tcp any 192.168.1.0 255.255.255.0 eq 443'),
    '',
    'Should accept ASA extended ACL syntax'
);
assert.strictEqual(
    asa.processCommand('access-group OUTSIDE_IN in interface outside'),
    '',
    'Should accept applying ACL to an interface'
);

const output = asa.processCommand('show access-lists');
assert.ok(output.includes('access-list OUTSIDE_IN'), 'Show output should include the ACL name');
assert.ok(output.includes('permit tcp any 192.168.1.0 255.255.255.0 eq 443'), 'Show output should include the ACL rule');

const prompt = PromptEngine.getSystemPrompt('State', 'Hints');
assert.ok(prompt.includes('ACL QUICK REFERENCE'), 'Prompt should include ACL guidance');
assert.ok(prompt.includes('access-list 100 deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'), 'Prompt should include IOS ACL example');
assert.ok(prompt.includes('access-list OUTSIDE_IN extended permit tcp any 192.168.1.0 255.255.255.0 eq 443'), 'Prompt should include ASA ACL example');

console.log('ASA ACL tests passed successfully.');
