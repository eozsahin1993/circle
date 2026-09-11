import { getAppSettings, updateAppSettings } from '@/services/settings';

/**
 * Reaction pushes are now scoped to the post's own owner and only fire on
 * their first reaction (see notify-circle.ts) — the volume concern that
 * used to keep reactions out of the default level is gone, so a fresh
 * circle should start at the top of the ladder.
 */
test('a fresh install defaults to every category, including reactions', async () => {
  expect((await getAppSettings()).defaultPushLevel).toBe('reactions');
});

test('a stored preference overrides the default', async () => {
  await updateAppSettings({ defaultPushLevel: 'posts' });

  expect((await getAppSettings()).defaultPushLevel).toBe('posts');
});
