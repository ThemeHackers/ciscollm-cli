import { BaseSession } from './BaseSession';

export class NetconfSession extends BaseSession {
    constructor(private host: string, private port: number = 830) {
        super();
        this.state = {
            currentMode: 'PRIVILEGED_EXEC',
            hostname: `netconf-${host}`,
            prompt: `NETCONF@${host}:${port}`
        };
    }

    public async connect(): Promise<void> {
        console.log(`[NetconfSession - ${this.host}]: Establishing SSH subsystem connection on port ${this.port}...`);
        console.log(`[NetconfSession - ${this.host}]: Exchanging capabilities (<hello> message)...`);
        return Promise.resolve();
    }

    public async execute(xmlPayload: string): Promise<string> {
        console.log(`[NetconfSession - ${this.host}]: Sending RPC request...`);
        const cleanPayload = xmlPayload.trim();

       
        if (cleanPayload.includes('<edit-config>')) {
            console.log(`[NetconfSession]: RPC Request:\n${cleanPayload}`);
           
            return `<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply message-id="101" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <ok/>
</rpc-reply>`;
        }

        if (cleanPayload.includes('<get-config>')) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<rpc-reply message-id="102" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <data>
    <native xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-native">
      <hostname>${this.state.hostname}</hostname>
      <interface>
        <GigabitEthernet>
          <name>1</name>
          <ip>
            <address>
              <primary>
                <address>10.0.0.1</address>
                <mask>255.255.255.0</mask>
              </primary>
            </address>
          </ip>
        </GigabitEthernet>
      </interface>
    </native>
  </data>
</rpc-reply>`;
        }

      
        console.warn(`[NetconfSession Warning]: XML payload not recognized. Parsing command: "${xmlPayload}"`);
        return `<rpc-reply message-id="999"><ok/></rpc-reply>`;
    }

    public async disconnect(): Promise<void> {
        console.log(`[NetconfSession - ${this.host}]: Session cleanly closed.`);
        return Promise.resolve();
    }
}
