export const DESTRUCTIVE_TOKENS = [
    'erase', 'reload', 'delete', 'format', 'write erase', 
    'boot system', 'config-register', 'crypto key zeroize'
];

export const IOS_ERROR_PATTERNS = [
    { type: 'AmbiguousCommand', regex: /% Ambiguous command/i },
    { type: 'IncompleteCommand', regex: /% Incomplete command/i },
    { type: 'InvalidInput', regex: /% Invalid input detected at/i },
    { type: 'InvalidCommand', regex: /% Unrecognized command/i },
    { type: 'BadInterfaceParameter', regex: /% Bad interface parameter/i },
    { type: 'CommandRejected', regex: /% Command rejected/i },
    { type: 'AccessDenied', regex: /% Permission denied/i }
];


export const PROMPT_REGEX = /(?:^|[\r\n])\s*([A-Za-z0-9_\-@\.:\(\)/\\<\[]+(?:>|#|\$|\]))\s*$/;


export const MORE_REGEX = /(?:--\s*More\s*--|---\s*\(more\)\s*---|---- More ----|Press any key to continue|Press SPACE to continue)/i;



export const DEFAULT_PROTECTED_INTERFACES = [
    'GigabitEthernet0/0',
    'GigabitEthernet0/1',
    'GigabitEthernet1/0',
    'Vlan1'
];
