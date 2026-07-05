import { IOSDevice } from './IOSDevice';

export class SwitchDevice extends IOSDevice {
    constructor(initialHostname?: string) {
        super(initialHostname || 'Switch1', 'switch');
    }

   
}
