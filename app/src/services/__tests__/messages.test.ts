import { setMessageListener, showDone, showError, showMessage, type Message } from '@/services/messages';

afterEach(() => setMessageListener(null));

function collect(): Message[] {
  const seen: Message[] = [];
  setMessageListener((message) => seen.push(message));
  return seen;
}

test('hands the message to whoever is listening', () => {
  const seen = collect();
  const onPress = jest.fn();

  showMessage('Photo deleted', { action: { label: 'Undo', onPress } });

  expect(seen).toEqual([{ text: 'Photo deleted', tone: 'neutral', action: { label: 'Undo', onPress } }]);
});

test('marks a failure as one, so the bar can say so without the wording having to', () => {
  const seen = collect();

  showError('Could not leave the circle');

  expect(seen).toEqual([{ text: 'Could not leave the circle', tone: 'error' }]);
});

test('marks a completed act as one, so a confirmation never looks like a problem', () => {
  const seen = collect();

  showDone('Keyset copied for decryptlog');

  expect(seen).toEqual([{ text: 'Keyset copied for decryptlog', tone: 'done' }]);
});

// A domain function shouldn't have to know whether any UI is mounted, so
// this has to be a no-op rather than a throw — it runs on paths that are
// already handling a failure.
test('drops a message when nothing is listening', () => {
  expect(() => showError('Nobody is home.')).not.toThrow();
});

test('stops delivering once the host unmounts', () => {
  const listener = jest.fn();
  setMessageListener(listener);
  setMessageListener(null);

  showMessage('Gone.');

  expect(listener).not.toHaveBeenCalled();
});
