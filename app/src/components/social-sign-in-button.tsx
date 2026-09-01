import { AntDesign } from '@expo/vector-icons';
import { Pressable, View, StyleSheet, type PressableProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { ThemedText } from '@/components/themed-text';
import { ButtonHeight, Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SocialSignInButtonProps = Omit<PressableProps, 'style'> & {
  provider: 'apple' | 'google';
};

/** Google's standard four-color "G" mark — required as-is, not recolored to match app theme. */
function GoogleLogo() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.8741 2.6836-6.615z"
      />
      <Path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1818l-2.9087-2.2581c-.8059.54-1.8368.8591-3.0477.8591-2.344 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <Path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 000 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <Path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </Svg>
  );
}

/**
 * "Continue with Apple" / "Continue with Google" — Apple's own guidelines
 * require its button as a fixed white/black pair regardless of app theme;
 * Google's mark is similarly fixed-color, but the pill itself follows the
 * app's usual outlined-button look instead of Google's own filled style,
 * to sit next to the Apple button without one looking like an afterthought.
 */
export function SocialSignInButton({ provider, ...rest }: SocialSignInButtonProps) {
  const theme = useTheme();
  const isApple = provider === 'apple';

  return (
    <Pressable {...rest}>
      {({ pressed }) => (
        <View style={[styles.button, isApple ? styles.apple : styles.google, pressed && styles.pressed]}>
          {isApple ? <AntDesign name="apple" size={18} color="#000000" /> : <GoogleLogo />}
          <ThemedText type="buttonLabel" style={isApple ? styles.appleLabel : { color: theme.text }}>
            Continue with {isApple ? 'Apple' : 'Google'}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: ButtonHeight.primary,
    borderRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24,
  },
  apple: {
    backgroundColor: '#F4EDE2',
  },
  appleLabel: {
    color: '#000000',
  },
  google: {
    borderWidth: 1,
    borderColor: Tints.secondaryButtonBorder,
  },
  pressed: {
    opacity: 0.85,
  },
});
