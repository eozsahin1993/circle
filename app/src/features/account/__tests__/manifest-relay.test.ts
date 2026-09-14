const mockGetAuthToken = jest.fn();
jest.mock('@/services/keystore', () => ({
  getAuthToken: () => mockGetAuthToken(),
}));

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));

import { getManifest, ManifestConflictError, putManifest } from '@/features/account/manifest-relay';

const RELAY_URL = 'http://localhost:8080';
const AUTH_TOKEN = 'test-session-token';

beforeAll(() => {
  process.env.EXPO_PUBLIC_RELAY_URL = RELAY_URL;
});

beforeEach(() => {
  global.fetch = jest.fn();
  jest.clearAllMocks();
  mockGetAuthToken.mockResolvedValue(AUTH_TOKEN);
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('getManifest', () => {
  test('GETs and decodes a stored blob', async () => {
    const encoded = Buffer.from([4, 5, 6]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ blob: encoded, version: 7 }));

    const result = await getManifest();

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/account/manifest`);
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(result).toEqual({ blob: new Uint8Array([4, 5, 6]), version: 7 });
  });

  test('returns a null blob when the account has never stored a manifest', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ blob: null }));

    await expect(getManifest()).resolves.toEqual({ blob: null, version: 0 });
  });

  // Every manifest written before versioning has no version attribute, and
  // those rows still have to be writable — the first write quotes 0 back.
  test('reads a manifest stored before versioning as version 0', async () => {
    const encoded = Buffer.from([1]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ blob: encoded }));

    await expect(getManifest()).resolves.toEqual({ blob: new Uint8Array([1]), version: 0 });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(getManifest()).rejects.toThrow();
  });
});

describe('putManifest', () => {
  test('PUTs the base64-encoded blob with the version it was read at', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ ok: true }));

    await putManifest(new Uint8Array([1, 2, 3]), 4);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/account/manifest`);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      blob: Buffer.from([1, 2, 3]).toString('base64'),
      expectedVersion: 4,
    });
  });

  // Distinct from a generic failure: the caller has to re-read and reapply,
  // since the blob it built is now missing whatever the other device wrote.
  test('raises ManifestConflictError when another device wrote first', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 409));

    await expect(putManifest(new Uint8Array([1]), 2)).rejects.toThrow(ManifestConflictError);
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(putManifest(new Uint8Array([1]), 0)).rejects.toThrow();
  });
});

