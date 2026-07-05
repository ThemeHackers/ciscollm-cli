import { EventEmitter } from 'events';

export const simulatorEvents = new EventEmitter();

export abstract class BaseDevice {
    public hostname: string;
    public type: string;
    public mode: string = 'USER_EXEC';

    constructor(hostname: string, type: string) {
        this.hostname = hostname;
        this.type = type;
    }


    public abstract processCommand(cmd: string): string;


    public abstract getPrompt(): string;
    

    public getHostname(): string {
        return this.hostname;
    }
}
