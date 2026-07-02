import type { CollectionEntry } from "astro:content";
import { slugifyStr } from "./slugify.ts";

export type TopicName =
  | "Operations"
  | "Platform"
  | "Product"
  | "AI"
  | "Weekly Review"
  | "Annual Review";

export type TopicDefinition = {
  name: TopicName;
};

export type TopicTag = {
  tag: string;
  tagName: TopicName;
};

export type TopicGroup = TopicDefinition & {
  slug: string;
  count: number;
  posts: CollectionEntry<"posts">[];
  previewPosts: CollectionEntry<"posts">[];
};

export const TOPICS: TopicDefinition[] = [
  { name: "Operations" },
  { name: "Platform" },
  { name: "Product" },
  { name: "AI" },
  { name: "Weekly Review" },
  { name: "Annual Review" },
];

function topicSlug(value: string): string {
  return slugifyStr(value);
}

function getPrimaryTagSlug(post: CollectionEntry<"posts">): string {
  const [primaryTag] = post.data.tags;
  return primaryTag ? topicSlug(primaryTag) : "";
}

export function getTopicTags(posts: CollectionEntry<"posts">[]): TopicTag[] {
  const slugsInUse = new Set(
    posts.flatMap(post => post.data.tags.map(tag => topicSlug(tag)))
  );

  return TOPICS.map(topic => ({
    tag: topicSlug(topic.name),
    tagName: topic.name,
  })).filter(({ tag }) => slugsInUse.has(tag));
}

export function getTopicGroups(
  posts: CollectionEntry<"posts">[],
  previewLimit = 3
): TopicGroup[] {
  return TOPICS.map(topic => {
    const slug = topicSlug(topic.name);
    const topicPosts = posts.filter(post => getPrimaryTagSlug(post) === slug);

    return {
      ...topic,
      slug,
      count: topicPosts.length,
      posts: topicPosts,
      previewPosts: topicPosts.slice(0, previewLimit),
    };
  });
}
