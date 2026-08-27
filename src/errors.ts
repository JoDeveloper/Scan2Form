export class ScanError extends Error {
    constructor(
        public code: string, 
        message: string, 
        public details?: any,
        public httpStatus: number = 500
    ) {
        super(message);
        this.name = 'ScanError';
    }
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Unknown error';
}
