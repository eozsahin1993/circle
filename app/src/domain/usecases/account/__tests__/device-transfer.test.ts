jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');
jest.mock('@/services/relay');
jest.mock('@/services/image');

import { Buffer } from 'buffer';
import { bytesToHex } from '@noble/curves/utils.js';

import { getAllCircles, getProfile, initDatabase, saveProfile } from '@/data/db';
import {
  approveDeviceTransfer,
  checkDeviceTransfer,
  inspectDeviceTransfer,
  startDeviceTransfer,
} from '@/domain/usecases/account/device-transfer';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { deriveDeviceTransferTag, generateEphemeralKeypair, openSealedBox } from '@/services/crypto';
import {
  addCircleKeyVersion,
  deleteCircleKeys,
  getCircleIdentity,
  getCircleKeyMap,
  getMasterSeed,
  saveMasterSeed,
} from '@/services/keystore';
import {
  deleteJoinRequest,
  getJoinRequestApproval,
  listJoinRequests,
  putJoinApproval,
  putJoinRequest,
} from '@/services/mailbox-relay';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { compressToThumbnail } from '@/services/image';
import { resetLocalDataForTesting } from '@/domain/usecases/dev-reset';

const SEED = new Uint8Array(16).fill(7);

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);
  (listJoinRequests as jest.Mock).mockResolvedValue([]);
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(null);
  (compressToThumbnail as jest.Mock).mockResolvedValue(new Uint8Array([9]));
  (deleteJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await resetLocalDataForTesting();
  await saveMasterSeed(SEED);
});

/**
 * Wires the two mocked mailbox halves together so a test can run both
 * sides of the handshake in one process: whatever the established device
 * PUTs is what the waiting device's poll returns.
 */
function connectMailbox() {
  (putJoinRequest as jest.Mock).mockImplementation(async (tag: string, id: string, encryptedRequest: Uint8Array) => {
    (listJoinRequests as jest.Mock).mockImplementation(async (queried: string) =>
      queried === tag ? [{ requesterId: id, encryptedRequest, encryptedApproval: null, createdAt: 1 }] : []
    );
  });
  (putJoinApproval as jest.Mock).mockImplementation(async (_tag: string, _id: string, sealed: Uint8Array) => {
    (getJoinRequestApproval as jest.Mock).mockResolvedValue(sealed);
  });
}

describe('the handshake end to end', () => {
  test('the waiting device ends up with the seed, profile, and circles', async () => {
    connectMailbox();
    await saveProfile({ name: 'Emre', picture: new Uint8Array([1, 2, 3]), createdAt: 10, updatedAt: 10 });
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const sentKeyMap = await getCircleKeyMap(circleId);
    const sentIdentity = await getCircleIdentity(circleId);

    // The waiting device publishes first; the QR is what it draws.
    const pending = await startDeviceTransfer('iPhone 15');

    const scanned = await inspectDeviceTransfer(JSON.stringify(pending.qr));
    expect(scanned).toMatchObject({ deviceName: 'iPhone 15', circleCount: 1 });

    await approveDeviceTransfer(scanned.qr);

    // Stand in for a second device: everything local is gone, and only
    // what came through the mailbox can bring it back.
    await resetLocalDataForTesting();
    expect(await getMasterSeed()).toBeNull();

    await expect(checkDeviceTransfer(pending)).resolves.toEqual({ transferred: true, circleCount: 1 });

    expect(await getMasterSeed()).toEqual(SEED);
    expect(await getProfile()).toMatchObject({ name: 'Emre', picture: new Uint8Array([1, 2, 3]) });
    expect(await getCircleKeyMap(circleId)).toEqual(sentKeyMap);
    // Same member, not a new one: the identity re-derives from the seed.
    expect(await getCircleIdentity(circleId)).toEqual(sentIdentity);
  });

  test('the arriving circle starts at cursor zero so it pulls from the beginning', async () => {
    connectMailbox();
    await createCircle({ name: 'Family Circle' });

    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    await resetLocalDataForTesting();
    await checkDeviceTransfer(pending);

    expect(await getAllCircles()).toMatchObject([{ metaCursor: 0, contentCursor: 0 }]);
  });

  test('polling before the other device has answered reports nothing yet', async () => {
    connectMailbox();
    const pending = await startDeviceTransfer('iPhone 15');

    await expect(checkDeviceTransfer(pending)).resolves.toEqual({ transferred: false });
  });

  test('a circle whose keys this device lacks is left out rather than sent half-formed', async () => {
    connectMailbox();
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    // Simulates the one state that can produce this: a row that survived
    // without its keystore entries.
    await deleteCircleKeys(circleId);

    const pending = await startDeviceTransfer('iPad');
    const scanned = await inspectDeviceTransfer(JSON.stringify(pending.qr));
    await approveDeviceTransfer(scanned.qr);

    await resetLocalDataForTesting();
    await expect(checkDeviceTransfer(pending)).resolves.toEqual({ transferred: true, circleCount: 0 });
  });
});

describe('the scanned code', () => {
  test.each([
    ['a barcode that is not ours', 'https://example.com/some-qr'],
    ['valid JSON of the wrong shape', JSON.stringify({ hello: 'world' })],
    ['a bad transfer code', JSON.stringify({ transferCode: '!!', ephemeralPublicKey: 'a'.repeat(64) })],
    ['a public key that is not 32 bytes', JSON.stringify({ transferCode: 'ABCD-EFGH-JKLM', ephemeralPublicKey: 'ff' })],
  ])('is rejected: %s', async (_label, raw) => {
    await expect(inspectDeviceTransfer(raw)).rejects.toThrow("doesn't look like a Circle transfer code");
  });

  test('is rejected once its mailbox row is gone', async () => {
    const pending = await startDeviceTransfer('iPhone 15');
    (listJoinRequests as jest.Mock).mockResolvedValue([]);

    await expect(inspectDeviceTransfer(JSON.stringify(pending.qr))).rejects.toThrow('expired or was already used');
  });
});

test('the relay only ever sees a tag, never the transfer code itself', async () => {
  const pending = await startDeviceTransfer('iPhone 15');

  const [tag] = (putJoinRequest as jest.Mock).mock.calls[0];
  expect(tag).toBe(deriveDeviceTransferTag(pending.transferCode));
  expect(tag).not.toContain(pending.transferCode);
});

test('the sealed payload is opaque to anyone but the waiting device', async () => {
  connectMailbox();
  await saveProfile({ name: 'Emre', picture: null, createdAt: 10, updatedAt: 10 });
  await createCircle({ name: 'Family Circle' });

  const pending = await startDeviceTransfer('iPhone 15');
  await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

  const [, , sealed] = (putJoinApproval as jest.Mock).mock.calls[0];
  const onTheWire = Buffer.from(sealed).toString('utf8');
  expect(onTheWire).not.toContain(bytesToHex(SEED));
  expect(onTheWire).not.toContain('Family Circle');
  expect(onTheWire).not.toContain('Emre');
});

describe('what the payload carries', () => {
  test('every key version travels, not just the newest', async () => {
    connectMailbox();
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    // Two rotations on top of the founding key.
    await addCircleKeyVersion(circleId, 2, new Uint8Array(32).fill(2));
    await addCircleKeyVersion(circleId, 3, new Uint8Array(32).fill(3));
    const sentKeyMap = await getCircleKeyMap(circleId);
    expect(Object.keys(sentKeyMap!)).toHaveLength(3);

    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    await resetLocalDataForTesting();
    await checkDeviceTransfer(pending);

    // Losing an old version would mean silently undecryptable history.
    expect(await getCircleKeyMap(circleId)).toEqual(sentKeyMap);
  });

  test('several circles all arrive, each with its own keys', async () => {
    connectMailbox();
    const first = await createCircle({ name: 'Family Circle' });
    const second = await createCircle({ name: 'Book Club' });
    const keys = {
      [first.id]: await getCircleKeyMap(first.id),
      [second.id]: await getCircleKeyMap(second.id),
    };

    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    await resetLocalDataForTesting();
    await expect(checkDeviceTransfer(pending)).resolves.toEqual({ transferred: true, circleCount: 2 });

    expect(await getCircleKeyMap(first.id)).toEqual(keys[first.id]);
    expect(await getCircleKeyMap(second.id)).toEqual(keys[second.id]);
    expect((await getAllCircles()).map((circle) => circle.name).sort()).toEqual(['Book Club', 'Family Circle']);
  });

  test('an account with no profile picture still transfers', async () => {
    connectMailbox();
    await saveProfile({ name: 'Emre', picture: null, createdAt: 10, updatedAt: 10 });

    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    await resetLocalDataForTesting();
    await checkDeviceTransfer(pending);

    expect(await getProfile()).toMatchObject({ name: 'Emre', picture: null });
  });
});

describe('the seal', () => {
  /**
   * The property the QR direction exists to buy: a relay that swapped in
   * its own key would have to be the one that supplied it, and it never
   * is. Standing in for that relay here — a different keypair cannot open
   * what was sealed to the scanned one.
   */
  test('opens only for the keypair whose public half was in the QR', async () => {
    connectMailbox();
    await createCircle({ name: 'Family Circle' });
    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    const [, , sealed] = (putJoinApproval as jest.Mock).mock.calls[0];
    expect(() => openSealedBox(sealed, generateEphemeralKeypair())).toThrow();
    expect(() => openSealedBox(sealed, pending.ephemeralKeypair)).not.toThrow();
  });

  test('a tampered payload is rejected rather than half-applied', async () => {
    connectMailbox();
    await createCircle({ name: 'Family Circle' });
    const pending = await startDeviceTransfer('iPad');
    await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

    const [, , sealed] = (putJoinApproval as jest.Mock).mock.calls[0];
    const corrupted = Uint8Array.from(sealed);
    corrupted[corrupted.length - 1] ^= 0xff;
    (getJoinRequestApproval as jest.Mock).mockResolvedValue(corrupted);

    await resetLocalDataForTesting();
    await expect(checkDeviceTransfer(pending)).rejects.toThrow();

    expect(await getMasterSeed()).toBeNull();
    expect(await getAllCircles()).toEqual([]);
  });
});

test('two transfers started in a row never share a code', async () => {
  const first = await startDeviceTransfer('iPad');
  const second = await startDeviceTransfer('iPad');

  expect(first.transferCode).not.toBe(second.transferCode);
  expect(first.qr.ephemeralPublicKey).not.toBe(second.qr.ephemeralPublicKey);
});

/**
 * Two polls can overlap: the interval fires again while the first is
 * still awaiting, and clearing the interval on unmount doesn't stop one
 * already in flight.
 */
test('collecting twice does not fail or duplicate the circle', async () => {
  connectMailbox();
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const pending = await startDeviceTransfer('iPad');
  await approveDeviceTransfer((await inspectDeviceTransfer(JSON.stringify(pending.qr))).qr);

  await resetLocalDataForTesting();
  await checkDeviceTransfer(pending);
  await expect(checkDeviceTransfer(pending)).resolves.toEqual({ transferred: true, circleCount: 1 });

  expect((await getAllCircles()).filter((circle) => circle.id === circleId)).toHaveLength(1);
});
