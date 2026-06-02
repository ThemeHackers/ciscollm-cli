export function normalizeInterfaceName(name: string): string {
    let clean = name.toLowerCase().replace(/\s+/g, '').trim();
    if (clean.startsWith('gigabitethernet')) {
      
    } else if (clean.startsWith('gig')) {
        clean = clean.replace(/^gig/, 'gigabitethernet');
    } else if (clean.startsWith('gi')) {
        clean = clean.replace(/^gi/, 'gigabitethernet');
    } else if (clean.startsWith('fastethernet')) {
        
    } else if (clean.startsWith('fa')) {
        clean = clean.replace(/^fa/, 'fastethernet');
    } else if (clean.startsWith('loopback')) {
    
    } else if (clean.startsWith('lo')) {
        clean = clean.replace(/^lo/, 'loopback');
    } else if (clean.startsWith('vlan')) {

    } else if (clean.startsWith('vl')) {
        clean = clean.replace(/^vl/, 'vlan');
    } else if (clean.startsWith('tengigabitethernet') || clean.startsWith('ten-gigabitethernet')) {
       
    } else if (clean.startsWith('te')) {
        clean = clean.replace(/^te/, 'tengigabitethernet');
    }
    return clean;
}

export function parseSimpleYaml(yaml: string): any {
    const result: any = {};
    const lines = yaml.split(/\r?\n/);
    let currentKey: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('-')) {
            if (currentKey && Array.isArray(result[currentKey])) {
                const val = trimmed.substring(1).trim().replace(/^['"]|['"]$/g, '');
                result[currentKey].push(val);
            }
        } else {
            const colonIndex = trimmed.indexOf(':');
            if (colonIndex !== -1) {
                const key = trimmed.substring(0, colonIndex).trim();
                const val = trimmed.substring(colonIndex + 1).trim().replace(/^['"]|['"]$/g, '');
                if (val === '') {
                    currentKey = key;
                    result[currentKey] = [];
                } else {
                    currentKey = null;
                    if (val.toLowerCase() === 'true') result[key] = true;
                    else if (val.toLowerCase() === 'false') result[key] = false;
                    else if (!isNaN(Number(val))) result[key] = Number(val);
                    else result[key] = val;
                }
            }
        }
    }
    return result;
}
