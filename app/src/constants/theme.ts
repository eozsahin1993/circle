/**
 * Hearth design system — literal values from the design handoff, no tokens to resolve.
 * The dim warm ground exists so photographs are the only bright thing on screen.
 */

import { Platform } from 'react-native';

export const Colors = {
  dark: {
    background: '#14100C',
    surface: '#1D1712',
    accent: '#C08A2E',
    accentBright: '#DCA645',
    accentLabel: '#17120C',
    text: '#F4EDE2',
    body: '#D8CDBE',
    secondary: '#BEB2A2',
    muted: '#8C8071',
    faint: '#7E7263',
    faintest: '#6E6455',
  },
  light: {
    background: '#F3EDE2',
    surface: '#FFFFFF',
    accent: '#A6552F',
    accentBright: '#A6552F',
    accentLabel: '#FFFFFF',
    text: '#231A11',
    body: '#3A2C1D',
    secondary: '#3A2C1D',
    muted: '#8A7B66',
    faint: '#8A7B66',
    faintest: '#8A7B66',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/** Photo placeholder slot background, light mode only — dark mode uses `surface`. */
export const PhotoSlotLight = '#DED4C4';

/** Swap this for terracotta / plum / moss — every other value in the system stays fixed. */
export const AlternateAccents = {
  ochre: '#C08A2E',
  terracotta: '#B4552F',
  plum: '#8C5A6B',
  moss: '#4E6B54',
} as const;

/** Non-solid fills — always composited over `surface` or `background`, dark mode only. */
export const Tints = {
  chipIdleBg: 'rgba(245,239,230,0.06)',
  chipIdleBorder: 'rgba(245,239,230,0.10)',
  chipReactedBg: 'rgba(192,138,46,0.18)',
  chipReactedBorder: 'rgba(192,138,46,0.45)',
  privacyWashBg: 'rgba(192,138,46,0.09)',
  privacyWashBorder: 'rgba(192,138,46,0.22)',
  secondaryButtonBorder: 'rgba(245,239,230,0.2)',
} as const;

export const Fonts = {
  serif: 'Newsreader_400Regular',
  serifLight: 'Newsreader_300Light',
  serifMedium: 'Newsreader_500Medium',
  sans: 'Figtree_400Regular',
  sansMedium: 'Figtree_500Medium',
  sansSemiBold: 'Figtree_600SemiBold',
  mono: Platform.select({ ios: 'Menlo', default: 'ui-monospace' }) ?? 'monospace',
} as const;

/** Font family + size/lineHeight/weight per the handoff's numbered type scale. */
export const Type = {
  onboardingHeadline: { fontFamily: Fonts.serifLight, fontSize: 37, lineHeight: 37 * 1.12 },
  circleListHeader: { fontFamily: Fonts.serifLight, fontSize: 32, lineHeight: 32 * 1.0 },
  screenTitle: { fontFamily: Fonts.serifLight, fontSize: 30, lineHeight: 30 * 1.1 },
  cardTitle: { fontFamily: Fonts.serif, fontSize: 21, lineHeight: 21 * 1.15 },
  captionDetail: { fontFamily: Fonts.serif, fontSize: 16.5, lineHeight: 16.5 * 1.5 },
  postAuthor: { fontFamily: Fonts.sansMedium, fontSize: 16, lineHeight: 16 * 1.3 },
  captionFeed: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 15 * 1.5 },
  comment: { fontFamily: Fonts.sans, fontSize: 14, lineHeight: 14 * 1.5 },
  buttonLabel: { fontFamily: Fonts.sansSemiBold, fontSize: 15, lineHeight: 15 * 1.2 },
  meta: { fontFamily: Fonts.sans, fontSize: 12.5, lineHeight: 12.5 * 1.4 },
  eyebrow: {
    fontFamily: Fonts.mono,
    fontSize: 9.5,
    lineHeight: 9.5 * 1.4,
    letterSpacing: 9.5 * 0.13,
    textTransform: 'uppercase',
  },
  inviteKey: {
    fontFamily: Fonts.mono,
    fontSize: 22,
    lineHeight: 22 * 1.3,
    letterSpacing: 22 * 0.13,
    textTransform: 'uppercase',
  },
} as const;

export const Radius = {
  pill: 999,
  circleCard: 18,
  panel: 16,
  input: 14,
  notice: 13,
  bottomSheet: 22,
} as const;

export const Spacing = {
  screenPadding: 22,
  cardListGap: 16,
  feedTextPadding: 18,
  topPadUnderStatusBar: 58,
  gapBetweenPosts: 34,
  pinnedButtonFromBottom: 34,
} as const;

export const ButtonHeight = { primary: 52 } as const;

/** Feed/detail posts: 4/5, edge to edge, no radius. Covers/memories: 16/9, radius = Radius.panel. */
export const PhotoAspect = { post: 4 / 5, cover: 16 / 9 } as const;
