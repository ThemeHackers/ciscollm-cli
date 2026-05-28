import { BaseSession } from './BaseSession';
import chalk from 'chalk';
import { Client } from 'ssh2';
import { Builder, Parser } from 'xml2js';

const NETCONF_BASE_1_0 = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NETCONF_BASE_1_1 = 'urn:ietf:params:netconf:base:1.1';

export type NetconfFramingVersion = '1.0' | '1.1';

export interface NetconfCredentials {
  username?: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  helloTimeoutMs?: number;
  rpcTimeoutMs?: number;
  readyTimeoutMs?: number;
  keepaliveInterval?: number;
}

export interface NetconfEditConfigObject {
  target?: 'candidate' | 'running' | 'startup';
  config: Record<string, any>;
  defaultOperation?: 'merge' | 'replace' | 'none' | 'remove';
  testOption?: 'test-then-set' | 'set' | 'test-only';
  errorOption?: 'stop-on-error' | 'continue-on-error' | 'rollback-on-error';
  messageId?: number | string;
}

export interface NetconfGetConfigObject {
  source?: 'candidate' | 'running' | 'startup';
  filter?: Record<string, any>;
  messageId?: number | string;
}

export interface NetconfRpcEnvelope {
  xml: string;
  parsed: Record<string, any>;
}

export class NetconfSession extends BaseSession {
  private sshClient: Client | null = null;
  private netconfStream: any = null;
  private connected = false;
  private connectionPromise: Promise<void> | null = null;
  private negotiatedFraming: NetconfFramingVersion = '1.0';
  private negotiatedCapabilities: string[] = [];
  private incomingBuffer = '';
  private bufferedMessages: string[] = [];
  private pendingMessageWaiters = new Map<string, {
    resolve: (payload: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private helloMessageWaiter: {
    resolve: (payload: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private nextMessageId = 1;
  private readonly parser = new Parser({
    explicitArray: false,
    ignoreAttrs: false,
    trim: true,
    attrkey: '$',
    charkey: '_'
  });
  private readonly builder = new Builder({
    headless: false,
    renderOpts: {
      pretty: true,
      indent: '  ',
      newline: '\n'
    }
  });

  constructor(
    private host: string,
    private port: number = 830,
    private credentials: NetconfCredentials = {}
  ) {
    super();
    this.state = {
      currentMode: 'PRIVILEGED_EXEC',
      hostname: `netconf-${host}`,
      prompt: `NETCONF@${host}:${port}`
    };
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    console.log(chalk.cyan(`❯ Establishing SSH NETCONF subsystem connection to ${this.host}:${this.port}...`));

    const client = new Client();
    this.sshClient = client;

    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });

    this.connectionPromise = promise.finally(() => {
      this.connectionPromise = null;
    });

    let settled = false;
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      this.connected = true;
      console.log(chalk.green(`✔ Exchanging capabilities (<hello> message) completed successfully.`));
      resolveConnection();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      this.cleanupConnection();
      rejectConnection(error);
    };

    client.on('error', fail);
    client.on('close', () => {
      this.connected = false;
      this.netconfStream = null;

      if (!settled) {
        fail(new Error(`NETCONF SSH connection to ${this.host}:${this.port} closed before the subsystem became ready.`));
        return;
      }

      this.rejectPending(new Error('NETCONF session closed.'));
    });

    client.on('ready', () => {
      client.subsys('netconf', (error: Error | undefined, stream: any) => {
        if (error) {
          fail(error);
          return;
        }

        this.netconfStream = stream;
        this.bindStream(stream);

        this.performHelloExchange()
          .then(succeed)
          .catch(fail);
      });
    });

    try {
      client.connect(this.buildConnectOptions());
    } catch (error) {
      fail(error as Error);
    }

    return this.connectionPromise;
  }

  public async execute(xmlPayload: string, timeoutMs: number = this.credentials.rpcTimeoutMs ?? 15000): Promise<string> {
    const response = await this.executeParsed(xmlPayload, timeoutMs);
    return response.xml;
  }

  public async executeParsed(xmlPayload: string, timeoutMs: number = this.credentials.rpcTimeoutMs ?? 15000): Promise<NetconfRpcEnvelope> {
    await this.connect();

    if (!this.netconfStream) {
      throw new Error('NETCONF session is not connected.');
    }

    const framedPayload = this.frameMessage(xmlPayload, this.negotiatedFraming);
    console.log(chalk.cyan(`❯ Sending NETCONF RPC request to ${this.host}...`));

    const msgIdMatch = /message-id=["']([^"']+)["']/i.exec(xmlPayload);
    const messageId = msgIdMatch ? msgIdMatch[1] : null;
    if (!messageId) {
      throw new Error('Unable to extract message-id from NETCONF RPC payload.');
    }

    await this.writeFrame(framedPayload);

    const xml = await this.waitForMessageForId(messageId, timeoutMs);
    const parsed = await this.parseRpcReply(xml);

    this.throwIfRpcError(parsed);

    return { xml, parsed };
  }

  public buildRpcRequest(request: NetconfEditConfigObject | NetconfGetConfigObject): string {
    if ('config' in request) {
      return this.buildEditConfigRpc(request);
    }

    return this.buildGetConfigRpc(request);
  }

  public buildEditConfigRpc(request: NetconfEditConfigObject): string {
    const messageId = String(request.messageId ?? this.nextMessageId++);
    const rpcBody: Record<string, any> = {
      rpc: {
        $: {
          xmlns: NETCONF_BASE_1_0,
          'message-id': messageId
        },
        'edit-config': [{
          target: [this.wrapTargetNode(request.target ?? 'running')],
          config: [this.toXmlNode(request.config)]
        }]
      }
    };

    const editConfig = rpcBody.rpc['edit-config'][0];
    if (request.defaultOperation) {
      editConfig['default-operation'] = [request.defaultOperation];
    }
    if (request.testOption) {
      editConfig['test-option'] = [request.testOption];
    }
    if (request.errorOption) {
      editConfig['error-option'] = [request.errorOption];
    }

    return this.builder.buildObject(rpcBody);
  }

  public buildGetConfigRpc(request: NetconfGetConfigObject = {}): string {
    const messageId = String(request.messageId ?? this.nextMessageId++);
    const rpcBody: Record<string, any> = {
      rpc: {
        $: {
          xmlns: NETCONF_BASE_1_0,
          'message-id': messageId
        },
        'get-config': [{
          source: [this.wrapTargetNode(request.source ?? 'running')]
        }]
      }
    };

    if (request.filter) {
      rpcBody.rpc['get-config'][0].filter = [this.toXmlNode(request.filter)];
    }

    return this.builder.buildObject(rpcBody);
  }

  public async parseRpcReply(xml: string): Promise<Record<string, any>> {
    const parsed = await this.parser.parseStringPromise(xml);
    return parsed as Record<string, any>;
  }

  public frameMessage(xmlPayload: string, framing: NetconfFramingVersion = this.negotiatedFraming): string {
    if (framing === '1.1') {
      const length = Buffer.byteLength(xmlPayload, 'utf8');
      return `\n#${length}\n${xmlPayload}\n##\n`;
    }

    return `${xmlPayload}]]>]]>`;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.negotiatedFraming = '1.0';
    this.negotiatedCapabilities = [];
    this.incomingBuffer = '';
    this.bufferedMessages = [];
    this.rejectPending(new Error('NETCONF session closed.'));

    if (this.netconfStream) {
      this.netconfStream.end?.();
      this.netconfStream = null;
    }

    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }

    console.log(chalk.green(`✔ NETCONF Session to ${this.host} cleanly closed.`));
  }

  private buildConnectOptions(): Record<string, any> {
    const username = this.credentials.username ?? process.env.NETCONF_USERNAME;
    const password = this.credentials.password ?? process.env.NETCONF_PASSWORD;

    if (!username) {
      throw new Error('NETCONF username is required. Pass it in the constructor or set NETCONF_USERNAME.');
    }

    return {
      host: this.host,
      port: this.port,
      username,
      password,
      privateKey: this.credentials.privateKey,
      passphrase: this.credentials.passphrase,
      readyTimeout: this.credentials.readyTimeoutMs ?? 20000,
      keepaliveInterval: this.credentials.keepaliveInterval ?? 10000,
      tryKeyboard: false
    };
  }

  private async performHelloExchange(): Promise<void> {
    const hello = this.buildHelloMessage();
    await this.writeFrame(this.frameMessage(hello, '1.0'));

    const helloTimeout = this.credentials.helloTimeoutMs ?? 15000;
    const peerHelloXml = await this.waitForHelloMessage(helloTimeout);
    const peerHello = await this.parseRpcReply(peerHelloXml);

    this.negotiatedCapabilities = this.extractCapabilities(peerHello);
    this.negotiatedFraming = this.negotiatedCapabilities.includes(NETCONF_BASE_1_1) ? '1.1' : '1.0';
  }

  private buildHelloMessage(): string {
    return this.builder.buildObject({
      hello: {
        $: {
          xmlns: NETCONF_BASE_1_0
        },
        capabilities: {
          capability: [NETCONF_BASE_1_0, NETCONF_BASE_1_1]
        }
      }
    });
  }

  private buildErrorMessage(errorPayload: any): string {
    const errors = Array.isArray(errorPayload) ? errorPayload : [errorPayload];
    const descriptions: string[] = [];

    for (const err of errors) {
      const errorTag = this.findFirstText(err?.['error-tag'] ?? err?.errorTag ?? err?.['error-type'] ?? err?.errorType);
      const errorMessage = this.findFirstText(err?.['error-message'] ?? err?.errorMessage ?? err?._);
      const errorPath = this.findFirstText(err?.['error-path'] ?? err?.errorPath);
      const errorInfo = err?.['error-info'] ? JSON.stringify(err['error-info']) : '';

      let desc = '';
      if (errorTag && errorMessage) {
        desc = `${errorTag}: ${errorMessage}`;
      } else if (errorTag) {
        desc = errorTag;
      } else {
        desc = errorMessage || 'Unknown NETCONF rpc-error';
      }

      if (errorPath) {
        desc += ` (path: ${errorPath})`;
      }
      if (errorInfo) {
        desc += ` (info: ${errorInfo})`;
      }
      descriptions.push(desc);
    }

    return descriptions.join('; ');
  }

  private throwIfRpcError(parsed: Record<string, any>): void {
    const reply = parsed['rpc-reply'] ?? parsed.rpcReply ?? parsed.rpc;
    const rpcError = reply?.['rpc-error'];

    if (!rpcError) {
      return;
    }

    const error = new Error(`NETCONF rpc-error: ${this.buildErrorMessage(rpcError)}`);
    (error as any).details = parsed;
    throw error;
  }

  private extractCapabilities(parsedHello: Record<string, any>): string[] {
    const hello = parsedHello.hello ?? parsedHello['hello'];
    const capabilityValue = hello?.capabilities?.capability ?? [];

    if (Array.isArray(capabilityValue)) {
      return capabilityValue.map(item => this.findFirstText(item)).filter(Boolean) as string[];
    }

    const single = this.findFirstText(capabilityValue);
    return single ? [single] : [];
  }

  private wrapTargetNode(target: 'candidate' | 'running' | 'startup'): Record<string, any> {
    return { [target]: [''] };
  }

  private toXmlNode(value: any): any {
    if (Array.isArray(value)) {
      return value.map(item => this.toXmlNode(item));
    }

    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'object') {
      const node: Record<string, any> = {};

      for (const [key, child] of Object.entries(value)) {
        if (key === '$' || key === '_') {
          node[key] = child;
          continue;
        }

        node[key] = [this.toXmlNode(child)];
      }

      return node;
    }

    return String(value);
  }

  private findFirstText(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const text = this.findFirstText(item);
        if (text) {
          return text;
        }
      }

      return '';
    }

    if (typeof value === 'object') {
      if (typeof value._ === 'string') {
        return value._.trim();
      }

      for (const child of Object.values(value)) {
        const text = this.findFirstText(child);
        if (text) {
          return text;
        }
      }
    }

    return '';
  }

  private async writeFrame(payload: string): Promise<void> {
    if (!this.netconfStream) {
      throw new Error('NETCONF stream is not available.');
    }

    await new Promise<void>((resolve, reject) => {
      const accepted = this.netconfStream.write(payload, (error: Error | undefined) => {
        if (error) {
          reject(error);
        }
      });

      if (accepted) {
        resolve();
        return;
      }

      this.netconfStream.once('drain', () => resolve());
      this.netconfStream.once('error', (error: Error) => reject(error));
    });
  }

  private bindStream(stream: any): void {
    stream.on('data', (chunk: Buffer | string) => {
      this.handleIncomingData(chunk.toString());
    });

    stream.on('error', (error: Error) => {
      this.rejectPending(error);
    });

    stream.on('close', () => {
      this.connected = false;
      this.netconfStream = null;
      this.rejectPending(new Error('NETCONF stream closed.'));
    });
  }

  private handleIncomingData(chunk: string): void {
    this.incomingBuffer += chunk;

    while (true) {
      const extracted = this.extractNextMessage(this.incomingBuffer, this.negotiatedFraming);
      if (!extracted) {
        return;
      }

      this.incomingBuffer = extracted.remainder;
      const payload = extracted.payload.trim();

      const msgIdMatch = /message-id=["']([^"']+)["']/i.exec(payload);
      const messageId = msgIdMatch ? msgIdMatch[1] : null;

      if (messageId) {
        const waiter = this.pendingMessageWaiters.get(messageId);
        if (waiter) {
          this.pendingMessageWaiters.delete(messageId);
          clearTimeout(waiter.timer);
          waiter.resolve(payload);
          continue;
        }
      } else if (this.helloMessageWaiter && payload.includes('<hello')) {
        const waiter = this.helloMessageWaiter;
        this.helloMessageWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
        continue;
      }

      this.bufferedMessages.push(payload);
    }
  }

  private extractNextMessage(buffer: string, framing: NetconfFramingVersion): { payload: string; remainder: string } | null {
    if (framing === '1.0') {
      const delimiter = ']]>]]>';
      const delimiterIndex = buffer.indexOf(delimiter);
      if (delimiterIndex === -1) {
        return null;
      }

      return {
        payload: buffer.slice(0, delimiterIndex),
        remainder: buffer.slice(delimiterIndex + delimiter.length)
      };
    }

    let cursor = 0;
    let payload = '';

    while (cursor < buffer.length) {
      while (cursor < buffer.length && (buffer[cursor] === '\n' || buffer[cursor] === '\r')) {
        cursor++;
      }

      if (cursor >= buffer.length) {
        return null;
      }

      if (buffer.startsWith('##', cursor)) {
        cursor += 2;
        if (buffer[cursor] === '\r') {
          cursor++;
        }
        if (buffer[cursor] === '\n') {
          cursor++;
        }

        return {
          payload,
          remainder: buffer.slice(cursor)
        };
      }

      if (buffer[cursor] !== '#') {
        return null;
      }

      cursor++;
      const lengthEnd = buffer.indexOf('\n', cursor);
      if (lengthEnd === -1) {
        return null;
      }

      const chunkLength = Number(buffer.slice(cursor, lengthEnd).trim());
      if (!Number.isFinite(chunkLength) || chunkLength < 0) {
        throw new Error(`Invalid NETCONF chunk length: ${buffer.slice(cursor, lengthEnd)}`);
      }

      cursor = lengthEnd + 1;
      if (buffer.length < cursor + chunkLength) {
        return null;
      }

      payload += buffer.slice(cursor, cursor + chunkLength);
      cursor += chunkLength;
    }

    return null;
  }

  private waitForHelloMessage(timeoutMs: number): Promise<string> {
    const bufferedIndex = this.bufferedMessages.findIndex(m => m.includes('<hello'));
    if (bufferedIndex !== -1) {
      const msg = this.bufferedMessages[bufferedIndex];
      this.bufferedMessages.splice(bufferedIndex, 1);
      return Promise.resolve(msg);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.helloMessageWaiter && this.helloMessageWaiter.timer === timer) {
          this.helloMessageWaiter = null;
        }
        reject(new Error(`NETCONF hello handshake timeout after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.helloMessageWaiter = {
        resolve,
        reject,
        timer
      };
    });
  }

  private waitForMessageForId(messageId: string, timeoutMs: number): Promise<string> {
    const bufferedIndex = this.bufferedMessages.findIndex(m => {
      const match = /message-id=["']([^"']+)["']/i.exec(m);
      return match ? match[1] === messageId : false;
    });

    if (bufferedIndex !== -1) {
      const msg = this.bufferedMessages[bufferedIndex];
      this.bufferedMessages.splice(bufferedIndex, 1);
      return Promise.resolve(msg);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingMessageWaiters.has(messageId)) {
          this.pendingMessageWaiters.delete(messageId);
        }
        reject(new Error(`NETCONF response timeout for message-id ${messageId} after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingMessageWaiters.set(messageId, {
        resolve,
        reject,
        timer
      });
    });
  }

  private rejectPending(error: Error): void {
    if (this.helloMessageWaiter) {
      const waiter = this.helloMessageWaiter;
      this.helloMessageWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }

    for (const waiter of this.pendingMessageWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pendingMessageWaiters.clear();
  }

  private cleanupConnection(): void {
    this.connected = false;
    this.negotiatedFraming = '1.0';
    this.negotiatedCapabilities = [];
    this.incomingBuffer = '';
    this.bufferedMessages = [];

    if (this.netconfStream) {
      this.netconfStream = null;
    }

    if (this.sshClient) {
      this.sshClient = null;
    }

    this.rejectPending(new Error('NETCONF connection reset.'));
  }
}
