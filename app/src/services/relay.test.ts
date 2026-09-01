const mockFile = {
  create: jest.fn(),
  write: jest.fn(),
  delete: jest.fn(),
  upload: jest.fn(),
};

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
  Paths: { cache: 'mock-cache-dir' },
  UploadType: { MULTIPART: 1, BINARY_CONTENT: 0 },
}));

const mockGetAuthToken = jest.fn();
jest.mock('@/services/keystore', () => ({
  getAuthToken: () => mockGetAuthToken(),
}));

import { appendEntry, fetchEntries, uploadBlob } from '@/services/relay';

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
  return { ok, status, json: async () => body } as Response;
}

describe('appendEntry', () => {
  test('POSTs base64-encoded encryptedMeta and returns the parsed result', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ epoch: 3, receivedAt: 12345, upload: { url: 'https://s3/bucket', fields: { key: 'circle-a/3' } } })
    );

    const result = await appendEntry('circle-a', 'post-1', new Uint8Array([1, 2, 3]));

    expect(result).toEqual({ epoch: 3, receivedAt: 12345, upload: { url: 'https://s3/bucket', fields: { key: 'circle-a/3' } } });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/circle-a/entries`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ entryId: 'post-1', encryptedMeta: Buffer.from([1, 2, 3]).toString('base64') });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(appendEntry('circle-a', 'post-1', new Uint8Array([1]))).rejects.toThrow();
  });

  test('throws without calling fetch when there is no stored session', async () => {
    mockGetAuthToken.mockResolvedValue(null);

    await expect(appendEntry('circle-a', 'post-1', new Uint8Array([1]))).rejects.toThrow('Not signed in.');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchEntries', () => {
  test('GETs with the since query param and decodes each entry’s base64 encryptedMeta', async () => {
    const encoded = Buffer.from([9, 9, 9]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ entries: [{ epoch: 1, encryptedMeta: encoded, receivedAt: 111 }], latestEpoch: 1, oldestAvailableEpoch: 1 })
    );

    const result = await fetchEntries('circle-a', 0);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/circle-a/entries?since=0`);
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(result.entries).toEqual([{ epoch: 1, encryptedMeta: new Uint8Array([9, 9, 9]), receivedAt: 111 }]);
    expect(result.latestEpoch).toBe(1);
    expect(result.oldestAvailableEpoch).toBe(1);
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 404));

    await expect(fetchEntries('circle-a', 0)).rejects.toThrow();
  });
});

describe('uploadBlob', () => {
  test('writes the bytes to a temp file, then uploads it with the target’s fields as multipart parameters', async () => {
    mockFile.upload.mockResolvedValue({ status: 200, body: '', headers: {} });
    const fields = { key: 'circle-a/3', 'Content-Type': 'application/octet-stream' };
    const bytes = new Uint8Array([1, 2, 3]);

    await uploadBlob({ url: 'https://s3/bucket', fields }, bytes);

    expect(mockFile.create).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFile.write).toHaveBeenCalledWith(bytes);
    const [url, options] = mockFile.upload.mock.calls[0];
    expect(url).toBe('https://s3/bucket');
    expect(options).toMatchObject({ fieldName: 'file', parameters: fields });
    expect(mockFile.delete).toHaveBeenCalled();
  });

  test('throws when the upload is rejected, and still cleans up the temp file', async () => {
    mockFile.upload.mockResolvedValue({ status: 403, body: '', headers: {} });

    await expect(uploadBlob({ url: 'https://s3/bucket', fields: {} }, new Uint8Array([1]))).rejects.toThrow();

    expect(mockFile.delete).toHaveBeenCalled();
  });
});
