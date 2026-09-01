import { appendEntry, fetchEntries, uploadBlob } from '@/services/relay';

const RELAY_URL = 'http://localhost:8080';

beforeAll(() => {
  process.env.EXPO_PUBLIC_RELAY_URL = RELAY_URL;
});

beforeEach(() => {
  global.fetch = jest.fn();
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
    expect(JSON.parse(init.body)).toEqual({ entryId: 'post-1', encryptedMeta: Buffer.from([1, 2, 3]).toString('base64') });
  });

  test('throws when the relay responds with an error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));

    await expect(appendEntry('circle-a', 'post-1', new Uint8Array([1]))).rejects.toThrow();
  });
});

describe('fetchEntries', () => {
  test('GETs with the since query param and decodes each entry’s base64 encryptedMeta', async () => {
    const encoded = Buffer.from([9, 9, 9]).toString('base64');
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ entries: [{ epoch: 1, encryptedMeta: encoded, receivedAt: 111 }], latestEpoch: 1, oldestAvailableEpoch: 1 })
    );

    const result = await fetchEntries('circle-a', 0);

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${RELAY_URL}/v1/circles/circle-a/entries?since=0`);
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
  test('POSTs the upload target’s fields plus the bytes as form data', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);

    await uploadBlob({ url: 'https://s3/bucket', fields: { key: 'circle-a/3', 'Content-Type': 'application/octet-stream' } }, new Uint8Array([1, 2, 3]));

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://s3/bucket');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  test('throws when the upload is rejected', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(uploadBlob({ url: 'https://s3/bucket', fields: {} }, new Uint8Array([1]))).rejects.toThrow();
  });
});
