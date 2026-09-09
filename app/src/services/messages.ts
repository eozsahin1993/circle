import type { IconGlyph } from '@/components/icon';

/**
 * A brief message for the person using the app — `SnackbarHost` draws it.
 *
 * A one-way push rather than a return value, because the code with
 * something to say often has no component to say it to: `runSync`'s
 * caller is a `setInterval`, so an outcome returned from there goes to a
 * timer. A host is always mounted to receive this — what's missing is a
 * call stack leading back to one, not a listener.
 *
 * Hence plain functions, not a hook, and hence this module sitting here
 * rather than beside the component: nothing under `components/` or
 * `hooks/` is imported by the layers below them.
 */
export type MessageOptions = {
  /** The one way out, if there is one. Dismisses the message when tapped. */
  action?: { label: string; onPress: () => void };
  /** A better glyph than the tone's own, where the subject has one — a bin beside "Photo deleted". */
  icon?: IconGlyph;
};

export type Message = MessageOptions & {
  text: string;
  /** Carried by the glyph rather than the fill: a red bar in this palette reads as an alert, and most of these aren't. */
  tone: 'done' | 'neutral' | 'error';
};

type Listener = (message: Message) => void;

/** Exactly one host is mounted. A message shown while none is listening is dropped, not held over. */
let listener: Listener | null = null;

/**
 * Says what happened, past tense, no full stop on a single clause, under
 * about sixty characters — the bar allows two lines and truncates past
 * them. Not for anything needing an answer, which is a dialog, nor for a
 * state that persists, which belongs in the feed.
 */
export function showMessage(text: string, options: MessageOptions = {}): void {
  listener?.({ ...options, text, tone: 'neutral' });
}

/** Confirms something the person asked for happened, where they can't otherwise see it. */
export function showDone(text: string, options: MessageOptions = {}): void {
  listener?.({ ...options, text, tone: 'done' });
}

/**
 * Reserved for what a person can't otherwise find out and can't get back:
 * anything the app retries on its own belongs in the log instead. Says
 * what failed, not why — the action is what offers the way out.
 */
export function showError(text: string, options: MessageOptions = {}): void {
  listener?.({ ...options, text, tone: 'error' });
}

/** Called by the host as it mounts, and with null as it unmounts. */
export function setMessageListener(next: Listener | null): void {
  listener = next;
}
