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
