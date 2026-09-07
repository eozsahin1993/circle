import { bytesToHex } from '@noble/curves/utils.js';

import {
  getAttachment,
  getCircleFeed,
  getCircleMemberCount,
  getCircleMemberEvents,
  getCircleSummary,
  getPostComments,
  getProfile,
  getUnseenCommentPostIds,
  type CommentWithAuthor,
  type FeedPost,
  type MemberEvent,
  type Profile,
  type ReactionSummary,
} from '@/data/db';
import { getReactionsForPost } from '@/domain/usecases/post/react-to-post';
import { getCircleIdentity } from '@/services/keystore';
import { ensurePhotoUri, writePhotoFile } from '@/services/photo-cache';

/** One post with everything the feed draws around it, gathered in one pass. */
export type FeedPostView = {
  post: FeedPost;
  photoUri?: string;
  reactions: ReactionSummary[];
  comments: CommentWithAuthor[];
  hasUnseenComments: boolean;
};

export type CircleFeed = {
  circleName: string;
  memberCount: number;
  profile: Profile | null;
  /** This device's identity in the circle. Null in the gap between joining and that join completing. */
  ownPublicKey: string | null;
  posts: FeedPostView[];
  events: MemberEvent[];
};

/**
 * Everything the feed screen shows, read in one pass from the local
 * database. Never touches the network: sync writes to SQLite and the
 * screen renders what's there, so the two stay independent and a slow
 * relay can't stall a repaint. Pending join requests are the exception
 * and deliberately not here — they come from the mailbox, and awaiting
 * them would put a network round-trip in front of content already on
 * disk (see `discoverPendingRequests`).
 *
 * Returns data, not view models: no formatted timestamps, no data URIs.
 * Those are the screen's business, and keeping them out means this can be
 * tested without a renderer.
 */
export async function loadCircleFeed(circleId: string): Promise<CircleFeed> {
  const [circle, memberCount, posts, profile, identity, events] = await Promise.all([
    getCircleSummary(circleId),
    getCircleMemberCount(circleId),
    getCircleFeed(circleId),
    getProfile(),
    getCircleIdentity(circleId),
    getCircleMemberEvents(circleId),
  ]);

  const ownPublicKey = identity ? bytesToHex(identity.publicKey) : null;

  // No identity yet briefly happens between joining and that join actually
  // completing — no posts have "new comments" to mark in that window either.
  const unseenCommentPostIds = ownPublicKey
    ? new Set(await getUnseenCommentPostIds(circleId, ownPublicKey, circle?.createdAt ?? 0))
    : new Set<string>();

  const photoUris = await resolvePhotoUris(circleId, posts);

  const [reactionsByPost, commentsByPost] = await Promise.all([
    Promise.all(posts.map((post) => getReactionsForPost(circleId, post.id))),
    Promise.all(posts.map((post) => getPostComments(circleId, post.id))),
  ]);

  return {
    circleName: circle?.name ?? '',
    memberCount,
    profile,
    ownPublicKey,
    events,
    posts: posts.map((post, index) => ({
      post,
      photoUri: photoUris.get(post.id),
      reactions: reactionsByPost[index],
      comments: commentsByPost[index],
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
