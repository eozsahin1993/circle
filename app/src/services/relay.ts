import { Buffer } from 'buffer';
import { File, Paths, UploadType } from 'expo-file-system';

import { generateUUID } from '@/services/crypto';

/**
 * Thin fetch-based client for the relay's three endpoints — see
 * server/DESIGN.md and server/internal/api. No retry/queueing logic
 * here; that's `domain/usecases/sync-circle.ts`'s job. This module only
 * knows how to talk to the wire, nothing about outbox/circleLog state.
 */

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

export type AppendResult = {
  epoch: number;
  receivedAt: number;
  upload: UploadTarget;
};

export type LogEntry = {
  epoch: number;
  encryptedMeta: Uint8Array;
  receivedAt: number;
};

export type FetchEntriesResult = {
  entries: LogEntry[];
  latestEpoch: number;
  oldestAvailableEpoch: number;
};

function baseUrl(): string {
  const url = process.env.EXPO_PUBLIC_RELAY_URL;
  if (!url) throw new Error('EXPO_PUBLIC_RELAY_URL is not set.');
  return url;
}

/** Appends one entry to a circle's log — POST /v1/circles/{circleLogId}/entries. */
export async function appendEntry(circleLogId: string, entryId: string, encryptedMeta: Uint8Array): Promise<AppendResult> {
  const response = await fetch(`${baseUrl()}/v1/circles/${circleLogId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId, encryptedMeta: Buffer.from(encryptedMeta).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to append entry: ${response.status}`);
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt, upload: body.upload };
}

/** Fetches every entry after `since` — GET /v1/circles/{circleLogId}/entries?since=. */
export async function fetchEntries(circleLogId: string, since: number): Promise<FetchEntriesResult> {
  const response = await fetch(`${baseUrl()}/v1/circles/${circleLogId}/entries?since=${since}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch entries: ${response.status}`);
  }
  const body = await response.json();
  return {
    entries: (body.entries as { epoch: number; encryptedMeta: string; receivedAt: number }[]).map((entry) => ({
      epoch: entry.epoch,
      encryptedMeta: new Uint8Array(Buffer.from(entry.encryptedMeta, 'base64')),
      receivedAt: entry.receivedAt,
    })),
    latestEpoch: body.latestEpoch,
    oldestAvailableEpoch: body.oldestAvailableEpoch,
  };
}

/**
 * Uploads ciphertext bytes straight to S3 using the presigned POST target
 * an `appendEntry` response handed back — never touches the relay itself.
 */
export async function uploadBlob(target: UploadTarget, bytes: Uint8Array): Promise<void> {
  const file = new File(Paths.cache, `upload-${generateUUID()}`);
  file.create({ overwrite: true });
  file.write(bytes);
  try {
    const result = await file.upload(target.url, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      parameters: target.fields,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Failed to upload blob: ${result.status} ${result.body}`);
    }
  } finally {
    file.delete();
  }
}
