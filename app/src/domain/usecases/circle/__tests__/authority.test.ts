jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/services/relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { getMemberByPublicKey, initDatabase, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import {
  decrypt,
  deriveAuthorityKeypair,
  deriveAuthorityKeyProofMessage,
  generateIdentity,
  sign,
  verify,
} from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

const MASTER_SEED = new Uint8Array(16);

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(MASTER_SEED);
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/**
 * The invariant everything else rests on: an admin on the roster is an
 * admin the relay accepts, because the founder's key enters the set at
 * bootstrap and every later change moves both halves at once.
 */
test('a founder is an admin holding the key the relay was bootstrapped with', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const own = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
  const registered = (bootstrapCircle as jest.Mock).mock.calls[0][1];

  const founder = await getMemberByPublicKey(circleId, own);
  expect(founder?.role).toBe(MemberRoles.admin);
  expect(founder?.authorityPublicKey).toBe(bytesToHex(registered));
});

/**
 * Only its owner can derive an authority key, so it has to travel on the
 * log — and with a proof, or a member could publish someone else's key as
 * their own and a promotion would install the wrong governor.
 */
test('a founder’s member_added publishes their authority key with a proof they hold it', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;

  const [, , , encryptedMeta] = (appendEntry as jest.Mock).mock.calls.find((call) => call[1] === 'meta')!;
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(encryptedMeta, current.key)));

  const keypair = deriveAuthorityKeypair(MASTER_SEED, circleId);
  expect(envelope.payload.authorityPublicKey).toBe(bytesToHex(keypair.publicKey));
  expect(envelope.payload.authorityKeyProof).toBe(
    bytesToHex(sign(deriveAuthorityKeyProofMessage(bytesToHex(identity.publicKey)), keypair.secretKey))
  );
});

/** The proof is worthless unless it is bound to the identity claiming it. */
test('an authority-key proof does not verify against a different identity', async () => {
  const authority = generateIdentity();
  const identityPublicKey = bytesToHex(generateIdentity().publicKey);
  const proof = sign(deriveAuthorityKeyProofMessage(identityPublicKey), authority.secretKey);

  expect(verify(proof, deriveAuthorityKeyProofMessage(identityPublicKey), authority.publicKey)).toBe(true);
  expect(verify(proof, deriveAuthorityKeyProofMessage(bytesToHex(generateIdentity().publicKey)), authority.publicKey)).toBe(false);
});
