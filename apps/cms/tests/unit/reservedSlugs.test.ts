import { describe, expect, it } from "vitest";

import { resolveSlugCollisions } from "../../src/lib/legacyContent";
import {
  RESERVED_ROOT_SLUGS,
  isReservedSlug,
} from "../../src/lib/reservedSlugs";
import {
  type ArticleInput,
  buildRedirectMap,
  deriveRule,
} from "../../src/lib/redirectMap";

describe("reserved root slugs (/{slug}/ must never shadow a real route)", () => {
  it.each([
    "admin",
    "api",
    "newsletter",
    "contact",
    "search",
    "category",
    "tag",
    "feed",
    "sitemap",
    "wp-content",
    "wp-admin",
    "wp-json",
  ])("%s is reserved, in any case", (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
    expect(isReservedSlug(slug.toUpperCase())).toBe(true);
  });

  it("does not reserve the generic fallback slug or ordinary words", () => {
    expect(isReservedSlug("article")).toBe(false);
    expect(isReservedSlug("my-story")).toBe(false);
    expect(isReservedSlug("search-results-for-lagos")).toBe(false);
  });

  it("every dotless entry is itself a valid slug (so the list is not dead weight)", () => {
    for (const s of RESERVED_ROOT_SLUGS)
      if (!s.includes("."))
        expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s), s).toBe(true);
  });

  it("the importer renames a colliding WordPress slug with a numeric suffix and reports the pair", () => {
    const r = resolveSlugCollisions([
      { slug: "search" },
      { slug: "Admin" },
      { slug: "fine-post" },
    ]);
    expect(r.items.map((i) => i.slug)).toEqual([
      "search-2",
      "admin-2",
      "fine-post",
    ]);
    expect(r.renamed).toEqual([
      { old: "search", new: "search-2" },
      { old: "Admin", new: "admin-2" },
    ]);
  });
});

describe("no redirect for an unchanged address under /{slug}/", () => {
  const article = (slug: string, legacyUrl: string): ArticleInput => ({
    id: slug,
    slug,
    legacyUrl,
    status: "published",
  });
  it("an imported post whose WordPress address equals its new address derives no rule", () => {
    expect(
      deriveRule(
        article("my-story", "https://old.example.test/my-story/"),
        "/{slug}/",
        ["old.example.test"],
      ),
    ).toEqual({
      skip: "sameAddress",
    });
    // no trailing slash and percent-encoding variants of the same address are the same key
    expect(
      deriveRule(
        article("my-story", "https://old.example.test/my-story"),
        "/{slug}/",
        ["old.example.test"],
      ),
    ).toEqual({
      skip: "sameAddress",
    });
  });

  it("a renamed slug still derives its 301", () => {
    const r = deriveRule(
      article("new-name", "https://old.example.test/old-name/"),
      "/{slug}/",
      ["old.example.test"],
    );
    expect(r).toMatchObject({
      rule: { from: "/old-name/", to: "/new-name/", status: 301 },
    });
  });

  it("buildRedirectMap emits no rule for posts that keep their address", () => {
    const r = buildRedirectMap({
      articles: [
        article("a", "https://old.example.test/a/"),
        article("b", "https://old.example.test/b/"),
      ],
      rows: [],
      template: "/{slug}/",
      allowedHosts: ["www.example.test"],
      legacyHosts: ["old.example.test"],
      now: new Date("2026-10-16T00:00:00Z"),
    });
    expect(r.map.rules).toEqual([]);
    expect(r.stats.skipped.sameAddress).toBe(2);
  });
});
