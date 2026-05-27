import * as assert from 'assert';
import { NetconfSession } from '../src/infrastructure/protocols/NetconfSession';

console.log('Running NETCONF session helper tests...\n');

async function main() {
    const session = new NetconfSession('router1', 830, { username: 'netconf', password: 'netconf' });

    const editConfigRpc = session.buildEditConfigRpc({
        target: 'running',
        config: {
            native: {
                hostname: 'router1'
            }
        },
        messageId: 7
    });

    assert.ok(editConfigRpc.includes('message-id="7"'), 'message id should be embedded as an rpc attribute');
    assert.ok(editConfigRpc.includes('<hostname>router1</hostname>'), 'dynamic XML payload should be serialized');

    const getConfigRpc = session.buildGetConfigRpc({
        source: 'running',
        messageId: 8
    });

    assert.ok(getConfigRpc.includes('<get-config>'), 'get-config RPC should be built');
    assert.ok(getConfigRpc.includes('message-id="8"'), 'get-config RPC should contain the requested message id as an rpc attribute');

    const framed10 = session.frameMessage('<rpc>test</rpc>', '1.0');
    assert.strictEqual(framed10, '<rpc>test</rpc>]]>]]>', 'NETCONF 1.0 framing should use end-of-message delimiter');

    const framed11 = session.frameMessage('<rpc>test</rpc>', '1.1');
    assert.ok(framed11.startsWith('\n#15\n'), 'NETCONF 1.1 framing should prefix the payload chunk length');
    assert.ok(framed11.endsWith('\n##\n'), 'NETCONF 1.1 framing should terminate with chunk end marker');

    const parsed = await session.parseRpcReply(`<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="7">
  <ok/>
</rpc-reply>`);

    assert.strictEqual(parsed['rpc-reply'].$['message-id'], '7', 'XML parser should retain message-id attributes');
    assert.ok(parsed['rpc-reply'].ok !== undefined, 'XML parser should expose the ok element');

    console.log(' -> NETCONF session helper tests passed.');
}

main().catch((error) => {
    console.error('NETCONF session helper tests FAILED:', error);
    process.exit(1);
});