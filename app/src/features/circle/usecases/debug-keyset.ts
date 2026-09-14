import { bytesToHex } from '@noble/curves/utils.js';

import { getCircle } from '@/data/db';
import { getCircleKeyMap } from '@/services/keystore';

/**
 * Formats this circle's syncId and full content-key history as
 * ready-to-paste flags for `server/cmd/decryptlog` — the dev tool that
 * decrypts a circle's real sync-log entries given its key material. Dev
 * builds only: this is the one place outside the device's own Keychain
 * that a content key ever becomes a plain string, so it exists purely to
 * cross the simulator/emulator → laptop clipboard boundary for debugging
 * (see server/cmd/decryptlog's own doc comment for why the relay itself
 * can never do this).
 *
 * Throws if the circle doesn't exist locally, or has no content-key map
 * yet (shouldn't happen for any circle that finished being created or
 * joined — see createCircle/completeJoin, both of which save one before
 * returning).
 */
export async function buildDebugKeysetFlags(circleId: string): Promise<string> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('Circle not found.');

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) throw new Error('No content keys stored for this circle.');

  const versions = Object.keys(keyMap)
    .map(Number)
    .sort((a, b) => a - b);
  const contentKeyFlags = versions.map((version) => `--content-key ${version}=${bytesToHex(keyMap[version])}`).join(' ');

  return `--sync-id ${circle.syncId} ${contentKeyFlags}`;
}
