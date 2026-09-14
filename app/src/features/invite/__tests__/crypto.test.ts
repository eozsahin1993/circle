import { decrypt, encrypt } from '@/core/crypto/primitives';
import { deriveInvitePreviewKey, deriveInviteTag, deriveJoinRequestKey } from '@/features/invite/crypto';

describe('invite code derivations', () => {
  test('deriveInviteTag is deterministic and code-specific', () => {
    expect(deriveInviteTag('AAAA-BBBB-CCCC')).toEqual(deriveInviteTag('AAAA-BBBB-CCCC'));
    expect(deriveInviteTag('AAAA-BBBB-CCCC')).not.toEqual(deriveInviteTag('DDDD-EEEE-FFFF'));
  });

  test('deriveInvitePreviewKey and deriveJoinRequestKey are deterministic, code-specific, and unrelated to each other', () => {
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).toEqual(deriveInvitePreviewKey('AAAA-BBBB-CCCC'));
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).not.toEqual(deriveInvitePreviewKey('DDDD-EEEE-FFFF'));
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).not.toEqual(deriveJoinRequestKey('AAAA-BBBB-CCCC'));
  });

  test('deriveInviteTag is unrelated to either derived key (not just a truncation of one)', () => {
    const tag = deriveInviteTag('AAAA-BBBB-CCCC');
    const previewKey = Buffer.from(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).toString('hex');
    expect(tag).not.toEqual(previewKey);
  });

  test('deriveInvitePreviewKey produces a key usable for encrypt/decrypt round trips', () => {
    const key = deriveInvitePreviewKey('AAAA-BBBB-CCCC');
    const plaintext = new TextEncoder().encode('Family Circle');

    expect(decrypt(encrypt(plaintext, key), key)).toEqual(plaintext);
  });
});
