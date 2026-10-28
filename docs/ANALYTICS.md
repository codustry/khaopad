# Visitor analytics

Khao Pad counts, on your own D1, how many people land on which page and where they came from. Nothing leaves your Cloudflare account, and nothing is recorded about a visitor who has not agreed to it.

This document is the contract: what is captured, what is deliberately not, and why the shape of the table is the guarantee rather than a promise in prose.

## The consent gate

Every write described here is gated on `consent.analytics`, the flag the v1.7a cookie banner sets. No consent means **no row and no D1 round-trip at all** — the gate short-circuits before a statement is even prepared. It is not "write now, delete later", because that is not consent.

The gate is pinned by tests in `src/lib/server/analytics/visitor-sources.integration.node.test.ts`, including an assertion that the D1 shim saw zero `prepare()` calls.

Visitors who decline are simply not counted. There is no fallback path, no "essential analytics" carve-out, and no cookie-free estimation.

## What is captured

Two tables, both pure counters.

### `page_views` — how many, per page

Keyed on `(date, path)`. One counter per page per UTC day.

### `visitor_sources` — where they came from

Keyed on `(date, channel, source, medium, campaign, path)`, with a `count` as the only payload.

| Column     | Example          | What it holds                                                          |
| ---------- | ---------------- | ---------------------------------------------------------------------- |
| `date`     | `2026-09-05`     | UTC calendar day. The finest time resolution stored, anywhere.         |
| `channel`  | `organic_search` | One of `direct`, `organic_search`, `social`, `referral`, `internal`.   |
| `source`   | `google`         | The referrer's **origin**, reduced to a known name — or `utm_source`.  |
| `medium`   | `organic`        | `organic`, `social`, `referral`, `internal`, `none` — or `utm_medium`. |
| `campaign` | `spring-launch`  | `utm_campaign`, or the literal `none` when the link was not tagged.    |
| `path`     | `/en/blog/hello` | Landing pathname. Querystring and fragment stripped.                   |
| `count`    | `47`             | How many landings matched that description that day.                   |

The UTM values are operator-set campaign data — you put them on your own marketing links — so they are first-party by construction, not something inferred about the visitor.

## What is deliberately NOT captured

This list is the point of the design. None of these exist as a column, an index, or a "we'll add it later".

**No full referring URL.** A referrer arrives as `https://www.google.co.th/search?q=<what they typed>` and is reduced to the single token `google` before anything is stored. The visitor's search terms, the referring page's own path, and any identifiers a partner site hangs off its query string are dropped inside `referrerOrigin()` and never reach the database.

**No session id.** There is no column that links two landings together. This is the load-bearing absence: with a session id, the rows would say "this person read A, then B, then bought C", which is an individual's browsing history. Without one, the table cannot say whether 47 landings were 47 people once or one person 47 times.

**No timestamp finer than the date.** Same reason. A per-visit row carrying `(timestamp, referrer, path)` reconstructs a journey through the site by sorting on time, even with no session id at all. The counter shape makes that arithmetically impossible — the rows have already been summed before they are stored.

**No IP address, no user agent, no fingerprint, no country.** None of these is written by the visitor-sources path.

**No per-visit rows at all.** Every landing is an `INSERT … ON CONFLICT DO UPDATE SET count = count + 1` against a composite primary key covering the whole dimension tuple. There is no append path to fall back to.

If a future feature seems to need any of the above, that feature is out of scope for this table. Do not add the column; the migration comment in `drizzle/0034_visitor_sources.sql` says the same thing to whoever reads it next.

> Note: the separate `events` table (`src/lib/server/analytics/events-schema.ts`, used by the shop and per-article dashboards) is a different, richer store with its own retention story. The guarantees above are about `visitor_sources` and `page_views`.

## Bounded cardinality

`source`, `medium` and `campaign` come partly from query parameters, which anyone can set. Storing them verbatim would let a stranger grow your table without bound with `?utm_source=<random>` — a storage bill and an availability problem.

So every one of those values, in `normalizeToken()`:

1. is lower-cased and trimmed,
2. must match `^[a-z0-9._+-]+$`,
3. must be at most 64 characters,

and is bucketed to the literal `other` otherwise. A spray of ten thousand distinct random values collapses into a single row. Unknown referrer hostnames go through the same funnel, since anyone can register a domain and link to you.

The narrow charset is also why no stored dimension can carry markup or whitespace into the admin table.

### Referrer spoofing

Search engines and social networks are matched against an allow-list. Multi-TLD engines (`google.com`, `google.co.th`, …) are matched by requiring the label to own the **registrable** domain — a naive substring test would classify `google.com.evil.example` as organic Google traffic and let anyone with a domain forge a `Referer` and write whatever source name they liked into your reports. See `matchKnown()` in `src/lib/server/analytics/sources.ts`.

## Where to see it

**Admin → Visitor sources** (`/admin/analytics`), editor role and above. Thirty-day window: channel breakdown, top sources, top campaigns, top landing pages, and landings per day.

Internal navigation is excluded from the sources and landing-pages tables — a visitor moving between your own pages is not an acquisition, and leaving it in would swamp every real source on any site with a nav bar. It remains visible as its own channel row.

## Files

| Path                                                                | What                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/lib/server/analytics/sources.ts`                               | Classification, normalisation, cardinality caps.                 |
| `src/lib/server/analytics/index.ts`                                 | `trackVisitorSource()` and the admin read queries.               |
| `src/lib/server/analytics/visitor-sources.integration.node.test.ts` | Pins the consent gate, the aggregate shape, the cardinality cap. |
| `drizzle/0034_visitor_sources.sql`                                  | The table.                                                       |
| `src/routes/(admin)/admin/analytics/`                               | The admin page.                                                  |
