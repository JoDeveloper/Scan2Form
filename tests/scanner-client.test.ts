import { Scan2Form } from '../src/scanner-client';

describe('Scanner client', () => {
    test('sends quality settings and returns a typed file', async () => {
        const body = JSON.stringify({ format: 'png', deviceId: 'scanner-1', dpi: 600, mode: 'gray' });
        const response = {
            ok: true,
            headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
            blob: async () => new Blob(['scan'], { type: 'image/png' }),
        } as unknown as Response;
        const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
            expect(init.method).toBe('POST');
            expect(init.credentials).toBe('omit');
            expect(init.cache).toBe('no-store');
            expect(JSON.parse(String(init.body))).toEqual(JSON.parse(body));
            return response;
        });

        const scanner = new Scan2Form({ fetch: fetchMock as unknown as typeof fetch });
        const result = await scanner.scan({ format: 'png', deviceId: 'scanner-1', dpi: 600, mode: 'gray' });

        expect(result.success).toBe(true);
        expect(result.file?.type).toBe('image/png');
        expect(result.file?.name).toMatch(/\.png$/);
    });

    test('normalizes detailed devices and keeps the legacy names API', async () => {
        const response = {
            ok: true,
            json: async () => ({ devices: [{ id: 'sane:usb-1', name: 'Office scanner', driver: 'sane' }, 'Office scanner'] }),
        } as unknown as Response;
        const fetchMock = jest.fn(async () => response);
        const scanner = new Scan2Form({ fetch: fetchMock as unknown as typeof fetch });

        const detailed = await scanner.listDevices();
        const names = await scanner.getDevices();

        expect(detailed.devices).toEqual([{ id: 'sane:usb-1', name: 'Office scanner', driver: 'sane' }]);
        expect(names.devices).toEqual(['Office scanner']);
    });

    test('rejects non-http bridge URLs', () => {
        expect(() => new Scan2Form('javascript:alert(1)')).toThrow('Bridge URL must use http or https');
    });
});
