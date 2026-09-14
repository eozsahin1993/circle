jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircle, initDatabase } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { buildDebugKeysetFlags } from '@/features/circle/usecases/debug-keyset';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle } from '@/core/services/relay';

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
