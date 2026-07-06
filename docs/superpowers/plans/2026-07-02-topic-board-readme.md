# Topic Board README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the template README with this blog's editorial direction and update the homepage to match the mockup: fixed backend topics with direct post selection.

**Architecture:** Keep AstroPaper's minimal shell, routing, content schema, tag pages, and post pages. Treat `tags` and `Topics` as the same taxonomy: each post has exactly one tag from `Operations`, `Platform`, `Product`, `AI`, `Weekly Review`, or `Annual Review`. Add a small topic grouping utility and one homepage-only `TopicBoard` component that renders those topics and their latest post links.

**Tech Stack:** Astro 6, TypeScript, Astro content collections, Tailwind CSS v4, Node's built-in test runner for the pure topic grouping utility, existing `pnpm astro check` and `pnpm build` verification.

---

## File Structure

- Modify `README.md`
  - Replace AstroPaper template marketing/docs with this repository's purpose, topic taxonomy, writing rules, and local commands.
- Create `src/utils/getTopicGroups.ts`
  - Define the fixed topics: `Operations`, `Platform`, `Product`, `AI`, `Weekly Review`, `Annual Review`.
  - Group sorted posts by `data.tags[0]`.
  - Preserve all topics even when one has no matching posts.
- Create `src/utils/getTopicGroups.test.ts`
  - Verify topic order, primary-tag-only grouping, preview limits, and empty-topic behavior.
- Create `src/components/TopicBoard.astro`
  - Render the topic cards from the latest mockup.
  - Link topic names to existing tag pages only when the topic has posts.
  - Link post titles directly to post detail pages.
- Modify `src/pages/index.astro`
  - Keep the header, hero, social links, RSS link, and footer.
  - Replace featured/recent homepage sections with `TopicBoard`.
  - Keep the existing "All Posts" link below the topic board.
- Modify `src/i18n/types.ts`
  - Add homepage labels needed by `TopicBoard`.
- Modify `src/i18n/lang/en.ts`
  - Add English labels for `Topics`, `All tags`, empty topic text, and "More {{topic}} posts".

---

## Task 1: Rewrite README Around The Blog Direction

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README with blog-specific content**

Use this structure:

````md
# hello tis blog

## Topics

- `Operations`
- `Platform`
- `Product`
- `AI`
- `Weekly Review`
- `Annual Review`

## Frontmatter

```md
---
title: 배포 파이프라인을 제품처럼 다루기
description: CI/CD를 내부 사용자 경험 관점에서 개선한 기록입니다.
pubDatetime: 2026-07-02T00:00:00Z
tags:
  - Platform
---
```

```md
---
title: 2026 Week 27 Review
description: Weekly notes about deployment automation and workflow.
pubDatetime: 2026-07-05T00:00:00Z
tags:
  - Weekly Review
---
```

```md
---
title: 2026 Annual Review
description: Annual notes across operations, platform, product, and AI.
pubDatetime: 2026-12-31T00:00:00Z
tags:
  - Annual Review
---
```

## Local Development

```bash
pnpm install
pnpm dev
pnpm build
```

## Credits

[AstroPaper](https://github.com/satnaing/astro-paper)
````

- [ ] **Step 2: Review README formatting**

Run:

```bash
pnpm exec prettier --check README.md
```

Expected:

```text
Checking formatting...
All matched files use Prettier code style!
```

- [ ] **Step 3: Commit README change**

Run:

```bash
git add README.md
git commit -m "docs: customize blog readme"
```

Expected: Git creates a commit containing only `README.md`.

---

## Task 2: Add Topic Grouping Utility With Tests

**Files:**
- Create: `src/utils/getTopicGroups.ts`
- Create: `src/utils/getTopicGroups.test.ts`

- [ ] **Step 1: Write the failing utility test**

Create `src/utils/getTopicGroups.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollectionEntry } from "astro:content";
import { getTopicGroups, TOPICS } from "./getTopicGroups.ts";

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
      ["operations", "platform", "product", "ai", "주간-회고"]
    );
  });

  it("groups posts by primary tag only and preserves incoming order", () => {
    const groups = getTopicGroups([
      post("Platform first", ["Platform", "Productivity"]),
      post("AI second", ["AI", "Workflow"]),
      post("Secondary platform does not count", ["Product", "Platform"]),
      post("Operations fourth", ["Operations", "Incident"]),
    ]);

    const platform = groups.find(group => group.name === "Platform");
    const product = groups.find(group => group.name === "Product");

    assert.equal(platform?.count, 1);
    assert.deepEqual(
      platform?.previewPosts.map(item => item.data.title),
      ["Platform first"]
    );
    assert.equal(product?.count, 1);
    assert.deepEqual(
      product?.previewPosts.map(item => item.data.title),
      ["Secondary platform does not count"]
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test src/utils/getTopicGroups.test.ts
```

Expected: FAIL because `src/utils/getTopicGroups.ts` does not exist.

- [ ] **Step 3: Add the minimal utility implementation**

Create `src/utils/getTopicGroups.ts`:

```ts
import type { CollectionEntry } from "astro:content";
import { slugifyStr } from "./slugify";

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

function getPrimaryTagSlug(post: CollectionEntry<"posts">): string {
  const [primaryTag] = post.data.tags;
  return primaryTag ? slugifyStr(primaryTag) : "";
}

export function getTopicGroups(
  posts: CollectionEntry<"posts">[],
  previewLimit = 3
): TopicGroup[] {
  return TOPICS.map(topic => {
    const slug = slugifyStr(topic.name);
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
```

- [ ] **Step 4: Run the utility test to verify it passes**

Run:

```bash
node --test src/utils/getTopicGroups.test.ts
```

Expected: PASS with four subtests.

- [ ] **Step 5: Commit the utility and test**

Run:

```bash
git add src/utils/getTopicGroups.ts src/utils/getTopicGroups.test.ts
git commit -m "feat: add homepage topic grouping"
```

Expected: Git creates a commit containing the utility and its test.

---

## Task 3: Add Homepage TopicBoard Component

**Files:**
- Create: `src/components/TopicBoard.astro`
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/lang/en.ts`

- [ ] **Step 1: Add i18n type fields**

In `src/i18n/types.ts`, extend `home`:

```ts
  home: {
    socialLinks: string;
    featured: string;
    recentPosts: string;
    allPosts: string;
    topics: string;
    allTags: string;
    noTopicPosts: string;
    moreTopicPosts: string;
  };
```

- [ ] **Step 2: Add English labels**

In `src/i18n/lang/en.ts`, extend `home`:

```ts
  home: {
    socialLinks: "Social Links",
    featured: "Featured",
    recentPosts: "Recent Posts",
    allPosts: "All Posts",
    topics: "Topics",
    allTags: "All Tags",
    noTopicPosts: "Posts are coming soon.",
    moreTopicPosts: "More {{topic}} posts",
  },
```

- [ ] **Step 3: Create `TopicBoard.astro`**

Create `src/components/TopicBoard.astro`:

```astro
---
import { getRelativeLocaleUrl } from "astro:i18n";
import { tplStr, useTranslations } from "@/i18n";
import type { TopicGroup } from "@/utils/getTopicGroups";
import { getPostUrl } from "@/utils/getPostPaths";
import config from "@/config";

type Props = {
  groups: TopicGroup[];
};

const { groups } = Astro.props;

const locale = Astro.currentLocale ?? config.site.lang;
const t = useTranslations(locale);
---

<section id="topics" class="pt-12 pb-6">
  <div class="mb-4 flex flex-wrap items-baseline justify-between gap-3">
    <h2 class="text-2xl font-semibold tracking-wide">{t.home.topics}</h2>
    <a
      href={getRelativeLocaleUrl(locale, "tags")}
      class="text-accent text-sm underline decoration-dashed underline-offset-4"
    >
      {t.home.allTags}
    </a>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    {
      groups.map(group => (
        <article class="border-border rounded-lg border bg-background p-4">
          <div class="border-border mb-3 flex items-baseline justify-between gap-3 border-b pb-3">
            <h3 class="text-accent text-lg font-semibold">
              {group.count > 0 ? (
                <a
                  href={getRelativeLocaleUrl(locale, `tags/${group.slug}/`)}
                  class="underline decoration-dashed underline-offset-4"
                >
                  #{group.name}
                </a>
              ) : (
                <span>#{group.name}</span>
              )}
            </h3>
            <span class="text-muted-foreground text-sm whitespace-nowrap">
              {group.count} posts
            </span>
          </div>

          <p class="text-muted-foreground mb-4 text-sm leading-6">
            {group.description}
          </p>

          {group.previewPosts.length > 0 ? (
            <ul class="grid gap-3">
              {group.previewPosts.map(post => (
                <li>
                  <a
                    href={getPostUrl(post.id, post.filePath, locale)}
                    class="hover:text-accent block font-medium leading-6"
                  >
                    {post.data.title}
                  </a>
                  <p class="text-muted-foreground mt-1 line-clamp-2 text-sm leading-6">
                    {post.data.description}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p class="text-muted-foreground text-sm">{t.home.noTopicPosts}</p>
          )}

          {group.count > group.previewPosts.length && (
            <a
              href={getRelativeLocaleUrl(locale, `tags/${group.slug}/`)}
              class="text-accent mt-4 inline-block text-sm underline decoration-dashed underline-offset-4"
            >
              {tplStr(t.home.moreTopicPosts, { topic: group.name })}
            </a>
          )}
        </article>
      ))
    }
  </div>
</section>
```

- [ ] **Step 4: Run type check to catch component or i18n mistakes**

Run:

```bash
pnpm astro check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the component**

Run:

```bash
git add src/components/TopicBoard.astro src/i18n/types.ts src/i18n/lang/en.ts
git commit -m "feat: add homepage topic board"
```

Expected: Git creates a commit containing the component and i18n updates.

---

## Task 4: Replace Homepage Lists With Topic Board

**Files:**
- Modify: `src/pages/index.astro`

- [ ] **Step 1: Import topic board and grouping utility**

In `src/pages/index.astro`, add:

```astro
import TopicBoard from "@/components/TopicBoard.astro";
import { getTopicGroups } from "@/utils/getTopicGroups";
```

Remove the now-unused `Card` import:

```astro
import Card from "@/components/Card.astro";
```

- [ ] **Step 2: Replace featured/recent variables with topic groups**

Replace:

```ts
const featuredPosts = sortedPosts.filter(({ data }) => data.featured);
const recentPosts = sortedPosts.filter(({ data }) => !data.featured);
```

with:

```ts
const topicGroups = getTopicGroups(sortedPosts, postsConfig.perIndex);
```

- [ ] **Step 3: Replace homepage post sections**

Remove the `featuredPosts` and `recentPosts` conditional sections from `src/pages/index.astro`.

Insert this after the hero section:

```astro
<TopicBoard groups={topicGroups} />
```

Keep the existing centered "All Posts" link after `TopicBoard`.

- [ ] **Step 4: Remove default hero copy**

Remove the default AstroPaper hero paragraphs and keep the title, RSS link, social links, topic board, and all-posts link.


- [ ] **Step 5: Run homepage type check**

Run:

```bash
pnpm astro check
```

Expected: PASS with no TypeScript or Astro template errors.

- [ ] **Step 6: Commit the homepage change**

Run:

```bash
git add src/pages/index.astro
git commit -m "feat: show topics on homepage"
```

Expected: Git creates a commit containing only the homepage composition change.

---

## Task 5: Verify Build And Visual Behavior

**Files:**
- No new files.

- [ ] **Step 1: Run full build**

Run:

```bash
pnpm build
```

Expected:

```text
astro check
astro build
pagefind --site dist
```

The command exits with status 0.

- [ ] **Step 2: Start local dev server**

Run:

```bash
pnpm dev
```

Expected: Astro starts a local server, usually at `http://localhost:4321/`.

- [ ] **Step 3: Verify homepage in browser**

Open the dev URL and check:

- The header and minimal AstroPaper layout remain intact.
- The hero no longer describes the AstroPaper template.
- The homepage shows topic cards in this order: `Operations`, `Platform`, `Product`, `AI`, `Weekly Review`, `Annual Review`.
- Each non-empty topic title links to its tag page.
- Empty topic titles are not links.
- Each visible post title links directly to its post page.
- Empty topics show only their post count.
- The "All Posts" link still works.
- Mobile width collapses the topic grid to one column.

- [ ] **Step 4: Stop local dev server**

Use `Ctrl+C` in the terminal running `pnpm dev`.

- [ ] **Step 5: Final status check**

Run:

```bash
git status --short
```

Expected: no uncommitted implementation changes. The saved plan under `docs/superpowers/plans/` and local mockup artifacts under `.superpowers/` may remain uncommitted if the user has not asked to commit planning files.

---

## Self-Review

- Spec coverage: README customization, fixed backend topics, first-tag primary topic rule, direct post selection from the homepage, weekly retrospective handling, and productivity placement are all represented.
- Placeholder scan: The plan contains no `TBD`, `TODO`, or unresolved implementation sections.
- Type consistency: The utility exports `TopicGroup`, `TOPICS`, and `getTopicGroups`; the component imports those exact names; the homepage imports `getTopicGroups` and `TopicBoard`.
