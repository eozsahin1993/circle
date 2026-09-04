import { updateMemberProfile } from '@/data/db';
import { parsePictureThumbnail } from '@/services/image';
import { authoredByMember, asRecord, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/**
 * What `broadcastProfileUpdate` puts in a `profile_update` entry. No
 * subject field on purpose — unlike `member_added`, this entry is always
 * about whoever signed it (`envelope.authorPubkey`), never about a
 * different member. There's nothing to spoof: a signature that verifies
 * against a claimed identity can't also claim to be updating someone
 * else's row.
 */
type ProfileUpdatePayload = {
  name: string;
  /**
   * Already validated and decoded — see `parsePictureThumbnail`. Absent
   * means "no picture", not "leave whatever's there" — a member clearing
   * their picture sends this with no `picture` field at all (or one that
   * fails validation), and `apply` below treats that as clearing it, not
   * skipping it.
   */
  picture?: Uint8Array;
};

function parse(payload: unknown): ProfileUpdatePayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  // allowEmpty: a member clearing their display name back to "" is a
  // legitimate update, not a malformed entry.
  const name = stringField(record, 'name', { allowEmpty: true });
  if (name === null) return null;
  return { name, picture: parsePictureThumbnail(record.picture) ?? undefined };
}

export const profileUpdateHandler: EntryHandler = {
  /**
   * Self-authored, not vouched for — this only describes the author
   * themselves, unlike `member_added`'s admission into the circle at all.
   * Anyone who has ever joined may update their own name/picture, with no
   * admin involved: `authoredByMember` is "has ever been a member," so a
   * removed member's last-known profile stays whatever it was (matches
   * `member_added`'s own history-isn't-retracted behavior — see
   * `authoredByMember`'s doc comment).
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;
    return authoredByMember(circleId, envelope);
  },

  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await updateMemberProfile(circleId, envelope.authorPubkey, {
      name: payload.name,
      picture: payload.picture ?? null,
    });
  },
};
