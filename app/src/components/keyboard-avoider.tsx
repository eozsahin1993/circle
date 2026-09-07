import { KeyboardAvoidingView, Platform, type ViewStyle, type StyleProp } from 'react-native';

export type KeyboardAvoiderProps = {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

/**
 * Keeps the focused input above the on-screen keyboard, on both platforms.
 *
 * Android needs a real `behavior` here, not `undefined`. Passing
 * `undefined` renders React Native's `default:` branch — a plain `View`
 * that compensates for nothing — which used to be survivable because the
 * window itself resized for the keyboard (`adjustResize`, still what
 * Expo's config plugin writes into the manifest). Under the edge-to-edge
 * display that SDK 57 forces on and no longer lets you disable, the
 * window doesn't shrink that way any more, so nothing moved the input at
 * all and the keyboard simply covered it.
 *
 * `height` is what works on Android: React Native measures the overlap
 * from the keyboard's absolute screen coordinates against this view's own
 * frame — no window resize required — and shrinks the container, so a
 * pinned footer (post/[id].tsx's comment composer) rides up with it and a
 * ScrollView above simply gets less room. iOS keeps `padding`, which is
 * the better fit for its own keyboard animation.
 */
export function KeyboardAvoider({ style, children }: KeyboardAvoiderProps) {
  return (
    <KeyboardAvoidingView style={style} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {children}
    </KeyboardAvoidingView>
  );
}
