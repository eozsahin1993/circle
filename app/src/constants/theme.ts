/**
 * Hearth design system — literal values from the design handoff, no tokens to resolve.
 * The dim warm ground exists so photographs are the only bright thing on screen.
 */

import { Platform } from 'react-native';

import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import Bookmark from 'lucide-react-native/icons/bookmark';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CloudDownload from 'lucide-react-native/icons/cloud-download';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import Heart from 'lucide-react-native/icons/heart';
import Images from 'lucide-react-native/icons/images';
import Link from 'lucide-react-native/icons/link';
import Lock from 'lucide-react-native/icons/lock';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import ShieldOff from 'lucide-react-native/icons/shield-off';
import Trash from 'lucide-react-native/icons/trash';
import UserX from 'lucide-react-native/icons/user-x';
import X from 'lucide-react-native/icons/x';

import type { IconGlyph } from '@/components/icon';

export const Colors = {
  dark: {
    background: '#14100C',
    surface: '#1D1712',
    accent: '#C08A2E',
    accentBright: '#DCA645',
    accentLabel: '#17120C',
    danger: '#D97A6E',
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
    danger: '#B8503F',
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
  dangerWashBorder: 'rgba(217,122,110,0.35)',
  dangerWashBg: 'rgba(217,122,110,0.12)',
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

/**
 * Named by what the icon means, not which glyph draws it — so the same
 * affordance can't end up drawn two different ways in two places, and
 * changing one is a single edit here. `satisfies` keeps a typo a compile
 * error instead of a silently missing icon.
 *
 * Imported one deep path at a time rather than from lucide's barrel; see
 * `IconGlyph` for why that matters.
 */
export const Icons = {
  back: ArrowLeft,
  close: X,
  /** Opens a menu of options for the thing it sits on. */
  more: Ellipsis,
  /** Trailing affordance on a row that navigates somewhere. */
  disclosure: ChevronRight,
  add: Plus,
  /** Opens the emoji picker on a post nobody has reacted to yet — outline, since it's an invitation rather than a reaction you left. */
  react: Heart,
  comment: MessageCircle,
  send: ArrowUp,
  locked: Lock,
  promote: ShieldCheck,
  demote: ShieldOff,
  removeMember: UserX,
  /** Deletes a photo from the circle for everyone — not "remove me from it". */
  deletePost: Trash,
  /** A photo whose entry has landed but whose bytes haven't yet. */
  photoArriving: CloudDownload,
  /** A photo whose download has failed enough times to stop looking temporary. */
  photoUnavailable: CircleAlert,
  /** The circle's album — every photo it holds, not just what's in the feed. */
  album: Images,
  /** Whether one post is kept in that album — the album seen from a single photo. Solid when it is; see `Icon`'s `filled`. */
  inAlbum: Bookmark,
  /** Sends a circle's key to someone who isn't in the room. */
  inviteLink: Link,
  /** Shows that key as a code to scan, for someone who is. */
  inviteCode: QrCode,
  /** Retires the key in circulation and mints a fresh one. */
  replaceKey: RefreshCw,
} as const satisfies Record<string, IconGlyph>;

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
  /**
   * The feed column's inset — captions, action chips, comments, roster
   * rows, and the header above them. Narrower than `screenPadding` so the
   * photographs, which run edge to edge, aren't squeezed by text margins
   * meant for a form.
   */
  feedTextPadding: 18,
  /**
   * The gap above a screen's header row — `ScreenHeader` applies it, so
   * only the two screens with their own header (`circle/index.tsx`,
   * `circle/feed.tsx`) name it directly.
   *
   * Small because it sits *under* the safe-area inset rather than instead
   * of it: `SafeAreaView`'s edges are `additive` by default, so its
   * padding stacks on the inset. That also makes this the whole gap the
   * eye sees on both platforms — Android's status bar inset is around
   * 24dp against an iPhone's ~59pt, and anything relying on the inset for
   * breathing room reads as cramped there.
   */
  topPadUnderSafeArea: 16,
  gapBetweenPosts: 34,
  /**
   * Above and below a roster-change row. Tighter than `gapBetweenPosts`
   * because that row is itself a rule across the feed — it already reads
   * as the break between two photographs, and a full gap on both sides
   * would leave it floating in a band of empty ground.
   */
  gapAroundMemberEvent: 20,
  pinnedButtonFromBottom: 34,
} as const;

export const ButtonHeight = { primary: 52 } as const;

/** Feed/detail posts: 4/5, edge to edge, no radius. Covers/memories: 16/9, radius = Radius.panel. */
export const PhotoAspect = { post: 4 / 5, cover: 16 / 9 } as const;
