import { IOSDevice } from './IOSDevice';

export class RouterDevice extends IOSDevice {
    constructor(initialHostname?: string) {
        super(initialHostname || 'Router1', 'router');
    }

   
}
