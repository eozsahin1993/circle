jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircle, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { buildDebugKeysetFlags } from '@/domain/usecases/circle/debug-keyset';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { getCircleKeyMap, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

test('buildDebugKeysetFlags includes the real syncId and every content-key version', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const circle = await getCircle(circleId);
  const keyMap = await getCircleKeyMap(circleId);

  const flags = await buildDebugKeysetFlags(circleId);

  expect(flags).toBe(`--sync-id ${circle!.syncId} --content-key 1=${bytesToHex(keyMap![1])}`);
});

test('buildDebugKeysetFlags throws for a circle that does not exist locally', async () => {
  await expect(buildDebugKeysetFlags('not-a-real-circle-id')).rejects.toThrow('Circle not found.');
});
