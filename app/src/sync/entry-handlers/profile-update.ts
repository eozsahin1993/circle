import { updateMemberProfile } from '@/data/db';
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
   * Base64-encoded avatar-sized JPEG thumbnail, same shape as
   * `member_added`'s own `picture` field — see `compressToThumbnail`.
   * Absent means "no picture", not "leave whatever's there" — a member
   * clearing their picture sends this with no `picture` field at all, and
   * `apply` below treats that as clearing it, not skipping it.
   */
  picture?: string;
};

function parse(payload: unknown): ProfileUpdatePayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  // allowEmpty: a member clearing their display name back to "" is a
  // legitimate update, not a malformed entry.
  const name = stringField(record, 'name', { allowEmpty: true });
  if (name === null) return null;
  const { picture } = record;
  if (picture !== undefined && typeof picture !== 'string') return null;
  return { name, picture };
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
      picture: payload.picture ? Buffer.from(payload.picture, 'base64') : null,
    });
  },
};
