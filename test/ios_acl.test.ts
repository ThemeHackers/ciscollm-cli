process.env.NODE_ENV = 'test';
import * as assert from 'assert';
import { IOSDevice } from '../src/server/devices/IOSDevice';

console.log('Running IOS ACL tests...\n');

const router = new IOSDevice('Router1');
assert.strictEqual(router.processCommand('enable'), '', 'Should enter privileged mode');
assert.ok(router.processCommand('configure terminal').includes('Enter configuration commands'), 'Should enter global config mode');
assert.strictEqual(
    router.processCommand('access-list 100 deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'),
    '',
    'Should accept extended ACL syntax'
);
assert.strictEqual(router.processCommand('interface GigabitEthernet0/1'), '', 'Should enter interface config mode');
assert.strictEqual(router.processCommand('ip access-group 100 in'), '', 'Should bind ACL inbound on interface');

const output = router.processCommand('show ip access-lists');
assert.ok(output.includes('Standard IP access list 100') || output.includes('Extended IP access list 100'), 'Should show ACL entries');
assert.ok(output.includes('deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'), 'Should list ACL rule');
assert.ok(output.includes('GigabitEthernet0/1 inbound 100'), 'Should show interface binding');

console.log('IOS ACL tests passed successfully.');
