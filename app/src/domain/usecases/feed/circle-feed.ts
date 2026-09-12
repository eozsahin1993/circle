import { bytesToHex } from '@noble/curves/utils.js';

import {
  getAttachment,
  getCircleFeedPage,
  getCircleMemberCount,
  getCircleMemberEventsSince,
  getCircleSummary,
  getCommentSummaries,
  getProfile,
  getUnseenCommentPostIds,
  type CommentSummary,
  type FeedCursor,
  type FeedPost,
  type MemberEvent,
  type Profile,
  type ReactionSummary,
} from '@/data/db';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { getPostReactionSummaries } from '@/data/db';
import { getCircleIdentity } from '@/services/keystore';
import { ensurePhotoUri, writePhotoFile } from '@/services/photo-cache';

export type { FeedCursor };

/** One post with everything the feed draws around it, gathered in one pass. */
export type FeedPostView = {
  post: FeedPost;
  photoUri?: string;
  reactions: ReactionSummary[];
  /** The one comment a card shows, and the count behind its "Show all" link. */
  comments: CommentSummary;
  hasUnseenComments: boolean;
};

/** Circle-level facts a page doesn't repeat — read once when the feed is (re)opened. */
export type CircleFeedMeta = {
  circleName: string;
  memberCount: number;
  profile: Profile | null;
  /** This device's identity in the circle. Null in the gap between joining and that join completing. */
  ownPublicKey: string | null;
  /** Whether the reader is an admin — with authorship, decides who may re-file a photo. */
  ownIsAdmin: boolean;
  /** Not rendered — only bounds getUnseenCommentPostIds, which a page fetches per its own posts. */
  circleCreatedAt: number;
};

export type CircleFeedPage = {
  posts: FeedPostView[];
  events: MemberEvent[];
  /** Pass this back in for the next page; null once every post is loaded. */
  nextCursor: FeedCursor | null;
};

export const FEED_PAGE_SIZE = 10;

/**
 * Circle-level facts, read once per feed open — never touches the network,
 * same as loadCircleFeedPage.
 */
export async function loadCircleFeedMeta(circleId: string): Promise<CircleFeedMeta> {
  const [circle, memberCount, profile, identity, ownIsAdmin] = await Promise.all([
    getCircleSummary(circleId),
    getCircleMemberCount(circleId),
    getProfile(),
    getCircleIdentity(circleId),
    isCircleAdmin(circleId),
  ]);

  return {
    circleName: circle?.name ?? '',
    memberCount,
    profile,
    ownPublicKey: identity ? bytesToHex(identity.publicKey) : null,
    ownIsAdmin,
    circleCreatedAt: circle?.createdAt ?? 0,
  };
}

/**
 * One page of the feed, read in a single pass from the local database:
 * `FEED_PAGE_SIZE` posts older than `cursor` (or the newest page, given
 * `null`), and every membership event in the exact time window those posts
 * span. Never touches the network: sync writes to SQLite and the screen
 * renders what's there, so the two stay independent and a slow relay can't
 * stall a repaint. Pending join requests are the exception and
 * deliberately not here — they come from the mailbox, and awaiting them
 * would put a network round-trip in front of content already on disk (see
 * `discoverPendingRequests`).
 *
 * An event's block only knows it's complete once every post that could
 * split it is known too (see groupMemberEvents), so this fetches every
 * event down to this page's oldest post — not just `FEED_PAGE_SIZE` of
 * them — while relying on `cursor` (this page's own lower bound, and the
 * *previous* page's own floor) to avoid re-fetching events an earlier
 * call already returned. The very last page (no more posts left to load)
 * has nothing further to ever split anything, so it takes every remaining
 * event with no floor at all.
 *
 * Returns data, not view models: no formatted timestamps, no data URIs.
 * Those are the screen's business, and keeping them out means this can be
 * tested without a renderer.
 */
export async function loadCircleFeedPage(
  circleId: string,
  meta: Pick<CircleFeedMeta, 'ownPublicKey' | 'circleCreatedAt'>,
  cursor: FeedCursor | null
): Promise<CircleFeedPage> {
  const { posts, hasMore } = await getCircleFeedPage(circleId, cursor, FEED_PAGE_SIZE);

  const oldestPost = posts[posts.length - 1];
  // No floor at all on the last page — see getCircleMemberEventsSince.
  const eventsFloor = hasMore && oldestPost ? oldestPost.createdAt : undefined;
  const events = await getCircleMemberEventsSince(circleId, eventsFloor, cursor?.createdAt);

  // No identity yet briefly happens between joining and that join actually
  // completing — no posts have "new comments" to mark in that window either.
  const unseenCommentPostIds = meta.ownPublicKey
    ? new Set(await getUnseenCommentPostIds(circleId, meta.ownPublicKey, meta.circleCreatedAt))
    : new Set<string>();

  const photoUris = await resolvePhotoUris(circleId, posts);

  // Two queries for the whole page, not two per post — see
  // getCommentSummaries on what the per-post version cost.
  const postIds = posts.map((post) => post.id);
  const [reactionsByPost, commentsByPost] = await Promise.all([
    meta.ownPublicKey ? getPostReactionSummaries(postIds, meta.ownPublicKey) : new Map<string, ReactionSummary[]>(),
    getCommentSummaries(circleId, postIds),
  ]);

  if (__DEV__) {
    console.log(
      `[loadCircleFeedPage] circle ${circleId}, cursor ${cursor ? cursor.createdAt : 'none (first page)'} -> ${posts.length} posts, ${events.length} events, hasMore=${hasMore}`
    );
  }

  return {
    events,
    nextCursor: hasMore && oldestPost ? { createdAt: oldestPost.createdAt, id: oldestPost.id } : null,
    posts: posts.map((post) => ({
      post,
      photoUri: photoUris.get(post.id),
      reactions: reactionsByPost.get(post.id) ?? [],
      comments: commentsByPost.get(post.id) ?? { latest: null, total: 0 },
      hasUnseenComments: unseenCommentPostIds.has(post.id),
    })),
  };
}

/**
 * Resolves each post's photo to a cached `file://` path. Only a post whose
 * file is missing — first sight, or a cache the OS cleared — costs a read
 * of its bytes; everything else is an existence check, which is what makes
 * re-entering the feed cheap.
 */
async function resolvePhotoUris(circleId: string, posts: FeedPost[]): Promise<Map<string, string>> {
  const uris = new Map<string, string>();

  for (const post of posts) {
    if (!post.hasPhoto) continue;

    let uri = ensurePhotoUri(circleId, post.id, () => null);
    if (!uri) {
      const attachment = await getAttachment(circleId, post.id);
      if (attachment?.bytes) uri = writePhotoFile(circleId, post.id, attachment.bytes);
    }
    if (uri) uris.set(post.id, uri);
  }

  return uris;
}
