import type { LucideIcon } from 'lucide-react-native';

/**
 * A glyph from the icon set, as the component that draws it rather than a
 * name to look up — see `Icons`, which is where the app names them. Deep
 * imports plus a component reference are what keep the bundle to the two
 * dozen icons actually used: Metro doesn't tree-shake, so a string-keyed
 * registry over lucide's barrel would ship all ~1,600.
 *
 * Lives in core, not beside `Icon`, so that non-UI code needing to shape a
 * message around an icon (see `core/services/messages.ts`) isn't reaching
 * into the UI layer for a type — the same reason `theme/tokens.ts`'s
 * `Icons` registry imports it from here too.
 */
export type IconGlyph = LucideIcon;
