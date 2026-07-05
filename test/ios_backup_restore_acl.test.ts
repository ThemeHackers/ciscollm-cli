process.env.NODE_ENV = 'test';
import * as assert from 'assert';
import { IOSDevice } from '../src/server/devices/IOSDevice';

console.log('Running IOS backup/restore ACL tests...\n');

const router = new IOSDevice('Router1');
assert.strictEqual(router.processCommand('enable'), '', 'Should enter privileged mode');
assert.ok(router.processCommand('configure terminal').includes('Enter configuration commands'), 'Should enter global config mode');
assert.strictEqual(router.processCommand('access-list 100 deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'), '', 'Should create initial ACL');
assert.strictEqual(router.processCommand('interface GigabitEthernet0/1'), '', 'Should enter interface config mode');
assert.strictEqual(router.processCommand('ip access-group 100 in'), '', 'Should bind ACL inbound');
assert.strictEqual(router.processCommand('end'), '', 'Should return to privileged exec');

assert.ok(router.processCommand('copy running-config flash:backup-agent.cfg').includes('Destination filename'), 'Should prompt for backup destination');
assert.ok(router.processCommand('').includes('[OK]'), 'Should complete backup copy');

assert.ok(router.processCommand('configure terminal').includes('Enter configuration commands'), 'Should re-enter global config mode');
assert.strictEqual(router.processCommand('no access-list 100 deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'), '', 'Should remove ACL rule before restore');
assert.strictEqual(router.processCommand('interface GigabitEthernet0/1'), '', 'Should re-enter interface config mode');
assert.strictEqual(router.processCommand('no ip access-group 100 in'), '', 'Should remove interface ACL binding before restore');
assert.strictEqual(router.processCommand('end'), '', 'Should return to privileged exec before restore');

const restoreResult = router.processCommand('configure replace flash:backup-agent.cfg force');
assert.ok(restoreResult.includes('Rollback Done'), 'Restore should succeed');

const showOutput = router.processCommand('show ip access-lists');
assert.ok(showOutput.includes('deny icmp 172.16.0.0 0.0.0.255 10.0.0.0 0.0.0.3'), 'ACL rule should be restored from backup');
assert.ok(showOutput.includes('GigabitEthernet0/1 inbound 100'), 'Interface ACL binding should be restored from backup');

console.log('IOS backup/restore ACL tests passed successfully.');
