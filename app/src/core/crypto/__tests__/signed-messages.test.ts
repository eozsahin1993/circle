import {
  AuthorityActions,
  deriveAuthorityChangeMessage,
  deriveAuthorityKeyProofMessage,
  deriveCoverPhotoUploadMessage,
  deriveDeleteAuthorContentMessage,
  deriveDeleteBlobMessage,
  deriveDeleteCircleMessage,
  deriveDeleteEntryMessage,
  deriveRotateMessage,
} from '@/core/crypto/signed-messages';

// Pins the literal bytes server/internal/synclog/messages_test.go must
// match — paired manually, since a drift here fails silently until the
// two sides talk.
describe('signed-messages byte construction', () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  test('deriveRotateMessage', () => {
    expect(deriveRotateMessage('sync-1', 'entry-1', 'hash-1')).toEqual(
      encode('mimoza-relay/rotate/v1\x00sync-1\x00entry-1\x00hash-1')
    );
  });

  test('deriveAuthorityChangeMessage add', () => {
    expect(deriveAuthorityChangeMessage(AuthorityActions.add, 'sync-1', 'entry-1', 'key-1')).toEqual(
      encode('mimoza-relay/authority-change/v1\x00add\x00sync-1\x00entry-1\x00key-1')
    );
  });

  test('deriveAuthorityChangeMessage remove', () => {
    expect(deriveAuthorityChangeMessage(AuthorityActions.remove, 'sync-1', 'entry-1', 'key-1')).toEqual(
      encode('mimoza-relay/authority-change/v1\x00remove\x00sync-1\x00entry-1\x00key-1')
    );
  });

  // Client-only — no Go counterpart. Included here for completeness of
  // this file's byte-construction coverage, not for cross-language parity.
  test('deriveAuthorityKeyProofMessage', () => {
    expect(deriveAuthorityKeyProofMessage('identity-1')).toEqual(
      encode('mimoza-relay/authority-key-proof/v1\x00identity-1')
    );
  });

  test('deriveCoverPhotoUploadMessage', () => {
    expect(deriveCoverPhotoUploadMessage('sync-1')).toEqual(encode('mimoza-relay/cover-photo-upload/v1\x00sync-1'));
  });

  test('deriveDeleteBlobMessage', () => {
    expect(deriveDeleteBlobMessage('sync-1', 'entry-1')).toEqual(
      encode('mimoza-relay/delete-blob/v1\x00sync-1\x00entry-1')
    );
  });

  test('deriveDeleteCircleMessage', () => {
    expect(deriveDeleteCircleMessage('sync-1', 'entry-1')).toEqual(
      encode('mimoza-relay/delete-circle/v1\x00sync-1\x00entry-1')
    );
  });

  test('deriveDeleteEntryMessage', () => {
    expect(deriveDeleteEntryMessage('sync-1', 'entry-1', 'tomb-1')).toEqual(
      encode('mimoza-relay/delete-entry/v1\x00sync-1\x00entry-1\x00tomb-1')
    );
  });

  test('deriveDeleteAuthorContentMessage', () => {
    expect(deriveDeleteAuthorContentMessage('sync-1', 'author-1', 'tomb-1')).toEqual(
      encode('mimoza-relay/delete-author-content/v1\x00sync-1\x00author-1\x00tomb-1')
    );
  });

  test('deriveDeleteAuthorContentMessage strip-only mode', () => {
    expect(deriveDeleteAuthorContentMessage('sync-1', 'author-1', '')).toEqual(
      encode('mimoza-relay/delete-author-content/v1\x00sync-1\x00author-1\x00')
    );
  });
});
