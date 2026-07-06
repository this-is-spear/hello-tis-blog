import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollectionEntry } from "astro:content";
import { getTopicGroups, getTopicTags, TOPICS } from "./getTopicGroups.ts";

function post(
  title: string,
  tags: string[],
  description = `${title} description`
): CollectionEntry<"posts"> {
  return {
    id: title.toLowerCase().replaceAll(" ", "-"),
    collection: "posts",
    data: {
      title,
      description,
      pubDatetime: new Date("2026-07-02T00:00:00Z"),
      tags,
    },
  } as CollectionEntry<"posts">;
}

describe("getTopicGroups", () => {
  it("returns the fixed backend topics in display order", () => {
    const groups = getTopicGroups([]);

    assert.deepEqual(
      groups.map(group => group.name),
      TOPICS.map(topic => topic.name)
    );
    assert.deepEqual(
      groups.map(group => group.slug),
      [
        "operations",
        "platform",
        "product",
        "ai",
        "weekly-review",
        "annual-review",
      ]
    );
  });

  it("groups posts by single topic tag and preserves incoming order", () => {
    const groups = getTopicGroups([
      post("Platform first", ["Platform"]),
      post("AI second", ["AI"]),
      post("Product third", ["Product"]),
      post("Operations fourth", ["Operations"]),
      post("Weekly fifth", ["Weekly Review"]),
      post("Annual sixth", ["Annual Review"]),
    ]);

    const platform = groups.find(group => group.name === "Platform");
    const product = groups.find(group => group.name === "Product");
    const weekly = groups.find(group => group.name === "Weekly Review");
    const annual = groups.find(group => group.name === "Annual Review");

    assert.equal(platform?.count, 1);
    assert.deepEqual(
      platform?.previewPosts.map(item => item.data.title),
      ["Platform first"]
    );
    assert.equal(product?.count, 1);
    assert.deepEqual(
      product?.previewPosts.map(item => item.data.title),
      ["Product third"]
    );
    assert.equal(weekly?.count, 1);
    assert.deepEqual(
      weekly?.previewPosts.map(item => item.data.title),
      ["Weekly fifth"]
    );
    assert.equal(annual?.count, 1);
    assert.deepEqual(
      annual?.previewPosts.map(item => item.data.title),
      ["Annual sixth"]
    );
  });

  it("limits preview posts but keeps the full count", () => {
    const groups = getTopicGroups(
      [
        post("One", ["AI"]),
        post("Two", ["AI"]),
        post("Three", ["AI"]),
        post("Four", ["AI"]),
      ],
      2
    );

    const ai = groups.find(group => group.name === "AI");

    assert.equal(ai?.count, 4);
    assert.deepEqual(
      ai?.previewPosts.map(item => item.data.title),
      ["One", "Two"]
    );
  });

  it("keeps empty topics visible", () => {
    const groups = getTopicGroups([post("Only Product", ["Product"])]);

    const operations = groups.find(group => group.name === "Operations");

    assert.equal(operations?.count, 0);
    assert.deepEqual(operations?.previewPosts, []);
  });
});

describe("getTopicTags", () => {
  it("returns only fixed topic tags in topic order", () => {
    const tags = getTopicTags([
      post("Platform post", ["Platform"]),
      post("AI post", ["AI"]),
      post("Docs post", ["docs"]),
      post("Operations post", ["Operations"]),
      post("Product post", ["Product"]),
      post("Weekly post", ["Weekly Review"]),
      post("Annual post", ["Annual Review"]),
    ]);

    assert.deepEqual(tags, [
      { tag: "operations", tagName: "Operations" },
      { tag: "platform", tagName: "Platform" },
      { tag: "product", tagName: "Product" },
      { tag: "ai", tagName: "AI" },
      { tag: "weekly-review", tagName: "Weekly Review" },
      { tag: "annual-review", tagName: "Annual Review" },
    ]);
  });

  it("ignores non-topic secondary tags", () => {
    const tags = getTopicTags([
      post("Mixed post", ["Platform", "Productivity", "Workflow"]),
    ]);

    assert.deepEqual(tags, [{ tag: "platform", tagName: "Platform" }]);
  });
});
