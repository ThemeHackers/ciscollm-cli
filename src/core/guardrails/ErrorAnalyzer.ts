import { IOS_ERROR_PATTERNS } from '../../shared/constants';

export interface IOSErrorStatus {
    hasError: boolean;
    errorType: string | null;
}

export class ErrorAnalyzer {
    
    public static checkOutput(output: string): IOSErrorStatus {
        for (const pattern of IOS_ERROR_PATTERNS) {
            if (pattern.regex.test(output)) {
                return { hasError: true, errorType: pattern.type };
            }
        }
        return { hasError: false, errorType: null };
    }
}
