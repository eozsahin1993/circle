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

import { bytesToHex } from '@noble/curves/utils.js';

import {
  appendEntry,
  BlobAlreadyExistsError,
  bootstrapCircle,
  fetchEntries,
  getBlob,
  getCoverPhotoUploadTarget,
  getManifest,
  getUploadTarget,
  putManifest,
  RateLimitedError,
  rotateLog,
  uploadBlob,
} from '@/services/relay';

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
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('bootstrapCircle', () => {
  test('POSTs the hex-encoded authority key and the write-token hash', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, true, 201));
    const founderKey = new Uint8Array([1, 2, 3]);

    await bootstrapCircle('sync-a', founderKey, 'deadbeef');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ founderAuthorityPublicKey: bytesToHex(founderKey), initialWriteTokenHash: 'deadbeef' });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 409));

    await expect(bootstrapCircle('sync-a', new Uint8Array([1]), 'deadbeef')).rejects.toThrow();
  });
});

describe('appendEntry', () => {
  test('POSTs namespace, base64-encoded encryptedMeta, keyVersion, and the hex-encoded write token', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ epoch: 3, receivedAt: 12345 }));
    const writeToken = new Uint8Array([9, 9]);

    const result = await appendEntry('sync-a', 'content', 'post-1', new Uint8Array([1, 2, 3]), 2, writeToken);

    expect(result).toEqual({ epoch: 3, receivedAt: 12345 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a/entries`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      namespace: 'content',
      entryId: 'post-1',
      encryptedMeta: Buffer.from([1, 2, 3]).toString('base64'),
      keyVersion: 2,
      writeToken: bytesToHex(writeToken),
    });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(appendEntry('sync-a', 'content', 'post-1', new Uint8Array([1]), 1, new Uint8Array([1]))).rejects.toThrow();
  });

  test('throws without calling fetch when there is no stored session', async () => {
    mockGetAuthToken.mockResolvedValue(null);

    await expect(appendEntry('sync-a', 'content', 'post-1', new Uint8Array([1]), 1, new Uint8Array([1]))).rejects.toThrow('Not signed in.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(appendEntry('sync-a', 'content', 'post-1', new Uint8Array([1]), 1, new Uint8Array([1]))).rejects.toBeInstanceOf(
      RateLimitedError
    );
  });
});

describe('rotateLog', () => {
  test('POSTs every field hex-encoded where applicable', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ epoch: 1, receivedAt: 1 }));
    const currentToken = new Uint8Array([1]);
    const authorityKey = new Uint8Array([2]);
    const signature = new Uint8Array([3]);

    await rotateLog('sync-a', 'rotate-1', new Uint8Array([9]), 1, currentToken, 'newhash', authorityKey, signature);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a/rotate`);
    expect(JSON.parse(init.body)).toEqual({
      entryId: 'rotate-1',
      encryptedMeta: Buffer.from([9]).toString('base64'),
      currentKeyVersion: 1,
      currentWriteToken: bytesToHex(currentToken),
      newWriteTokenHash: 'newhash',
      authorityPublicKey: bytesToHex(authorityKey),
      signature: bytesToHex(signature),
    });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 403));

    await expect(
      rotateLog('sync-a', 'rotate-1', new Uint8Array([1]), 1, new Uint8Array([1]), 'h', new Uint8Array([1]), new Uint8Array([1]))
    ).rejects.toThrow();
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(
      rotateLog('sync-a', 'rotate-1', new Uint8Array([1]), 1, new Uint8Array([1]), 'h', new Uint8Array([1]), new Uint8Array([1]))
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('fetchEntries', () => {
  test('GETs with the namespace and since query params and decodes each entry', async () => {
    const encoded = Buffer.from([9, 9, 9]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ entries: [{ epoch: 1, keyVersion: 2, encryptedMeta: encoded, receivedAt: 111 }], currentEpoch: 1 })
    );

    const result = await fetchEntries('sync-a', 'meta', 0);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a/entries?namespace=meta&since=0`);
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(result.entries).toEqual([{ epoch: 1, keyVersion: 2, encryptedMeta: new Uint8Array([9, 9, 9]), receivedAt: 111 }]);
    expect(result.currentEpoch).toBe(1);
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 404));

    await expect(fetchEntries('sync-a', 'content', 0)).rejects.toThrow();
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(fetchEntries('sync-a', 'content', 0)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('getUploadTarget', () => {
  test('POSTs the hex-encoded write token in the body', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ url: 'https://s3/bucket', fields: { key: 'sync-a/post-1' } }));
    const writeToken = new Uint8Array([9, 9]);

    const result = await getUploadTarget('sync-a', 'post-1', writeToken);

    expect(result).toEqual({ url: 'https://s3/bucket', fields: { key: 'sync-a/post-1' } });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a/entries/post-1/upload`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ writeToken: bytesToHex(writeToken) });
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  test('throws BlobAlreadyExistsError specifically on a 409, distinct from other error statuses', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 409));

    await expect(getUploadTarget('sync-a', 'post-1', new Uint8Array([1]))).rejects.toBeInstanceOf(BlobAlreadyExistsError);
  });

  test('throws a plain error on a non-409 error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 403));

    const err = await getUploadTarget('sync-a', 'post-1', new Uint8Array([1])).catch((e) => e);
    expect(err).not.toBeInstanceOf(BlobAlreadyExistsError);
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(getUploadTarget('sync-a', 'post-1', new Uint8Array([1]))).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('getCoverPhotoUploadTarget', () => {
  test('POSTs the hex-encoded write token, authority public key, and signature in the body', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ url: 'https://s3/bucket', fields: { key: 'sync-a/cover' } }));
    const writeToken = new Uint8Array([9, 9]);
    const authorityPublicKey = new Uint8Array([1, 2, 3]);
    const signature = new Uint8Array([4, 5, 6]);

    const result = await getCoverPhotoUploadTarget('sync-a', writeToken, authorityPublicKey, signature);

    expect(result).toEqual({ url: 'https://s3/bucket', fields: { key: 'sync-a/cover' } });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/sync-a/cover-photo/upload`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      writeToken: bytesToHex(writeToken),
      authorityPublicKey: bytesToHex(authorityPublicKey),
      signature: bytesToHex(signature),
    });
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 403));

    await expect(getCoverPhotoUploadTarget('sync-a', new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))).rejects.toThrow();
  });
});

describe('getBlob', () => {
  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(getBlob('sync-a', 'post-1')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('getManifest', () => {
  test('GETs and decodes a stored blob', async () => {
    const encoded = Buffer.from([4, 5, 6]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ blob: encoded }));

    const result = await getManifest();

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/account/manifest`);
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(result).toEqual(new Uint8Array([4, 5, 6]));
  });

  test('returns null when the account has never stored a manifest', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ blob: null }));

    await expect(getManifest()).resolves.toBeNull();
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(getManifest()).rejects.toThrow();
  });
});

describe('putManifest', () => {
  test('PUTs the base64-encoded blob', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ ok: true }));

    await putManifest(new Uint8Array([1, 2, 3]));

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/account/manifest`);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ blob: Buffer.from([1, 2, 3]).toString('base64') });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(putManifest(new Uint8Array([1]))).rejects.toThrow();
  });
});

describe('uploadBlob', () => {
  test('writes the bytes to a temp file, then uploads it with the target’s fields as multipart parameters', async () => {
    mockFile.upload.mockResolvedValue({ status: 200, body: '', headers: {} });
    const fields = { key: 'sync-a/post-1', 'Content-Type': 'application/octet-stream' };
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
