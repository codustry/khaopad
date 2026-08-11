import { describe, expect, it } from "vitest";
import { GET } from "./+server";

/**
 * GET /api/admin/search auth + shape pins (#160 C7).
 *
 * The query functions are covered against real SQLite in
 * $lib/server/admin/search.integration.node.test.ts; this file pins
 * the endpoint's gates, which need no database at all: auth runs
 * before anything touches the platform.
 */

type Event = Parameters<typeof GET>[0];

function makeEvent(opts: {
  user?: { role: string } | null;
  q?: string;
}): Event {
  return {
    url: new URL(
      `https://cms.example.com/api/admin/search?q=${encodeURIComponent(opts.q ?? "")}`,
    ),
    locals: {
      user: opts.user ?? null,
      content: {
        searchArticles: async () => [],
      },
    },
    platform: undefined,
  } as unknown as Event;
}

async function status(event: Event): Promise<number> {
  try {
    return (await GET(event)).status;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

describe("GET /api/admin/search", () => {
  it("401s without a signed-in user", async () => {
    expect(await status(makeEvent({ user: null }))).toBe(401);
  });

  it("403s below editor", async () => {
    expect(
      await status(makeEvent({ user: { role: "author" }, q: "khp" })),
    ).toBe(403);
  });

  it("returns empty groups (not an error) for short queries — before touching the platform", async () => {
    // platform is undefined in this event: reaching for the DB on a
    // sub-minimum query would throw 503 instead of the empty result.
    const res = await GET(makeEvent({ user: { role: "editor" }, q: "k" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orders: [],
      products: [],
      articles: [],
    });
  });

  it("503s for a real query when the platform is missing", async () => {
    expect(
      await status(makeEvent({ user: { role: "editor" }, q: "khp" })),
    ).toBe(503);
  });
});
