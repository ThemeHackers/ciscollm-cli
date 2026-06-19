import { TransactionManager } from '../src/core/rollback/TransactionManager';
import * as assert from 'assert';

async function runSpaceCheckTest() {
    console.log('Running TransactionManager Space Check Unit Test...');

  
    console.log(' -> Testing Case 1: Low disk space in flash (12000 bytes free)...');
    const lowSpaceSession = {
        getState: () => ({ currentMode: 'GLOBAL_CONFIG' }),
        execute: async (cmd: string) => {
            if (cmd === 'dir flash:') {
                return `Directory of flash:/
1 -rw- 1043072 Jun 3 2026 plink.exe
12000 bytes total (12000 bytes free)`;
            }
            if (cmd === 'show running-config') {
                return 'hostname Switch1\ninterface GigabitEthernet0/1\n!';
            }
            return 'OK';
        }
    } as any;

    const tx1 = new TransactionManager();
    await tx1.initializeBackup(lowSpaceSession);
    assert.strictEqual(tx1['backupCreated'], false, 'Backup should NOT be created when flash space is low');
    console.log('    [Passed] Successfully skipped backup on low space.');

   
    console.log(' -> Testing Case 2: Ample disk space in flash (15000000 bytes free)...');
    const ampleSpaceSession = {
        getState: () => ({ currentMode: 'GLOBAL_CONFIG' }),
        execute: async (cmd: string) => {
            if (cmd === 'dir flash:') {
                return `Directory of flash:/
15000000 bytes total (15000000 bytes free)`;
            }
            if (cmd === 'show running-config') {
                return 'hostname Switch1\ninterface GigabitEthernet0/1\n!';
            }
            if (cmd.includes('copy running-config')) {
                return 'copied successfully [OK]';
            }
            return 'OK';
        }
    } as any;

    const tx2 = new TransactionManager();
    await tx2.initializeBackup(ampleSpaceSession);
    assert.strictEqual(tx2['backupCreated'], true, 'Backup SHOULD be created when flash space is sufficient');
    console.log('    [Passed] Successfully created backup on ample space.');

    console.log('TransactionManager Space Check Unit Test passed successfully!');
    process.exit(0);
}

runSpaceCheckTest().catch(err => {
    console.error('Test FAILED:', err.stack || err.message || err);
    process.exit(1);
});
