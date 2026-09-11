import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The notification copy exists twice — describeEntry in handle-push.ts
 * for Android, compose in the iOS extension's NotificationService.swift —
 * and nothing but this test fails when one changes without the other.
 * Swift never runs under jest, so this checks both sources textually:
 * every fragment here must appear in both files.
 */

const composers = [
  join(__dirname, '..', 'handle-push.ts'),
  join(__dirname, '..', '..', '..', '..', '..', 'targets', 'CircleNotificationService', 'NotificationService.swift'),
];

const copyFragments = [
  'added a photo',
  'commented on your photo',
  'also commented',
  'reacted ',
  'to your photo',
  ' joined',
  'Someone',
];

test.each(composers.map((file) => [file.split('/').slice(-1)[0], file]))(
  'every copy fragment appears in %s',
  (_, file) => {
    const source = readFileSync(file, 'utf8');
    for (const fragment of copyFragments) {
      expect(source).toContain(fragment);
    }
  },
);
