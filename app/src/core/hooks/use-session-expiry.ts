import { router } from 'expo-router';
import { useEffect } from 'react';

import { i18n } from '@/core/i18n/i18n';
import { showError } from '@/core/services/messages';
import { setSessionExpiredListener } from '@/core/services/session';

/**
 * Sends the person back to sign in once the relay stops accepting this
 * device's session.
 *
 * Mounted in the root layout rather than on a screen: what notices is
 * almost always a background sync pass, and whichever screen happens to
 * be up when that lands has nothing to do with it. `index` resolves what
 * to show from there — the token is already gone, so it lands on the
 * welcome screen rather than bouncing back to the circles.
 */
export function useSessionExpiry(): void {
  useEffect(() => {
    setSessionExpiredListener(() => {
      showError(i18n.t('common.sessionExpired'));
      router.replace('/');
    });
    return () => setSessionExpiredListener(null);
  }, []);
}
