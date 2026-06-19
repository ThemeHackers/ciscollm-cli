import { SshSession } from '../src/infrastructure/protocols/SshSession';
import * as assert from 'assert';

async function runTest() {
    console.log('Connecting to SSH simulator on 127.0.0.1:2222...');
    const session = new SshSession({
        host: '127.0.0.1',
        port: 2222,
        username: 'admin',
        password: 'admin'
    });

    await session.connect();
    console.log('Connected successfully. Current mode:', session.getState().currentMode);

    console.log('\n--- Configuring Protocols ---');

    await session.execute('enable');
    await session.execute('configure terminal');
    
  
    console.log('Configuring EIGRP...');
    await session.execute('router eigrp 100');
    await session.execute('network 192.168.1.0');
    await session.execute('no auto-summary');
    await session.execute('exit');

  
    console.log('Configuring VTP...');
    await session.execute('vtp domain mydomain');
    await session.execute('vtp mode transparent');

   
    console.log('Configuring NTP...');
    await session.execute('ntp server 8.8.8.8');

 
    console.log('Configuring SNMP...');
    await session.execute('snmp-server community mysecret RO');


    console.log('Configuring NAT and ACL...');
    await session.execute('ip nat inside source list 1 interface GigabitEthernet0/0 overload');
    await session.execute('access-list 1 permit 192.168.1.0 0.0.0.255');


    console.log('Configuring interface GigabitEthernet0/1...');
    await session.execute('interface GigabitEthernet0/1');
    await session.execute('standby 1 ip 192.168.1.254');
    await session.execute('standby 1 priority 110');
    await session.execute('standby 1 preempt');
    await session.execute('vrrp 2 ip 192.168.1.253');
    await session.execute('vrrp 2 priority 125');
    await session.execute('ip nat inside');
    await session.execute('end');

    console.log('\n--- Querying Protocols via Show Commands ---');

    const protocols = await session.execute('show ip protocols');
    console.log(`\n[show ip protocols]:\n${protocols}`);
    assert.ok(protocols.includes('Routing Protocol is "eigrp 100"'), 'EIGRP configuration missing from show ip protocols');

    const vtp = await session.execute('show vtp status');
    console.log(`\n[show vtp status]:\n${vtp}`);
    assert.ok(vtp.includes('VTP Operating Mode                 : transparent'), 'VTP Mode configuration missing');
    assert.ok(vtp.includes('VTP Domain Name                    : mydomain'), 'VTP Domain configuration missing');

    const standby = await session.execute('show standby brief');
    console.log(`\n[show standby brief]:\n${standby}`);
    assert.ok(standby.includes('192.168.1.254'), 'HSRP VIP missing');

    const vrrp = await session.execute('show vrrp brief');
    console.log(`\n[show vrrp brief]:\n${vrrp}`);
    assert.ok(vrrp.includes('192.168.1.253'), 'VRRP VIP missing');

    const nat = await session.execute('show ip nat translations');
    console.log(`\n[show ip nat translations]:\n${nat}`);
    assert.ok(nat.includes('192.168.1.10'), 'NAT translations missing');

    const acls = await session.execute('show access-lists');
    console.log(`\n[show access-lists]:\n${acls}`);
    assert.ok(acls.includes('Standard IP access list 1'), 'ACL configuration missing');

    const ntp = await session.execute('show ntp status');
    console.log(`\n[show ntp status]:\n${ntp}`);
    assert.ok(ntp.includes('reference is 8.8.8.8'), 'NTP server missing');

    await session.disconnect();
    console.log('\nDisconnected cleanly. All protocol assertions PASSED!');
}

runTest().catch(console.error);
