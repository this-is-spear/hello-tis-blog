import type { CollectionEntry } from "astro:content";
import { postFilter } from "./postFilter";

/**
 * Returns posts that are eligible to be shown to users, sorted by publication
 * date descending. Editing a post does not change its position.
 *
 * Note: filtering respects drafts and scheduled posts via `postFilter()`.
 */
export function getSortedPosts(posts: CollectionEntry<"posts">[]) {
  return posts
    .filter(postFilter)
    .sort(
      (a, b) =>
        new Date(b.data.pubDatetime).getTime() -
        new Date(a.data.pubDatetime).getTime()
    );
}
