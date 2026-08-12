# @khaopad/plugin-careers

Public careers page at `/{locale}/careers`, rendered server-side from an
external ATS job feed. Ships no tables, no migrations, and no admin UI —
job postings are authored in the ATS, not in the CMS.

Applications are **not** rebuilt here. Each opening links out to the
ATS-hosted `apply_url` (for Tonbab People: a multi-step wizard with
resume upload and passwordless tracking).

## Enabling it

Set one variable in `wrangler.toml`:

```toml
[vars]
CAREERS_FEED_URL = "https://app.tonbab.com/api/careers/<tenant-slug>/jobs"
```

That's the whole configuration. It is not a secret — the feed is a
public, unauthenticated, read-only endpoint — so `[vars]` is the right
home for it rather than `wrangler secret`.

**When unset, the feature does not exist**: `/{locale}/careers` returns
404 and the header nav entry is not rendered. An install that doesn't
recruit publishes nothing.

Per-environment overrides go in the matching block:

```toml
[env.staging.vars]
CAREERS_FEED_URL = "https://staging.tonbab.com/api/careers/acme/jobs"
```

For local development, add the same key to `.dev.vars`.

## Pointing at your own feed

The URL can be any endpoint that returns the JSON shape below over
http(s) — Tonbab People is the reference implementation, but a static
JSON file in R2 or a Greenhouse/Lever export reshaped by a Worker works
identically. `feed.ts` treats the response as untrusted third-party
data regardless of where it came from.

```json
{
  "company": "Codustry",
  "jobs": [
    {
      "id": "6f2c…-uuid",
      "number": "JOB-0001",
      "title": "Full-stack Engineer (SvelteKit)",
      "department": "Engineering",
      "employment_type": "full_time",
      "location": "Bangkok / Remote",
      "category": {
        "slug": "engineering",
        "name_en": "Engineering",
        "name_th": "วิศวกรรม"
      },
      "salary": { "min": 60000, "max": 90000, "currency": "THB" },
      "published_at": "2026-08-01T04:00:00Z",
      "apply_url": "https://app.tonbab.com/careers/codustry/6f2c…"
    }
  ]
}
```

Only `id`, `title` and `apply_url` are required. A job missing any of
them is dropped; every other field degrades to null. A bare top-level
array (no `{company, jobs}` envelope) is also accepted.

Assumptions worth knowing, since the upstream contract does not state
them:

- **Salary figures are monthly.** The feed has no unit field, so
  JSON-LD emits `unitText: "MONTH"`. Feeds quoting annual figures will
  be mis-labelled in structured data — change `jsonld.ts` if yours does.
- **`salary` is null unless the posting opted in** (`show_salary`
  upstream). `baseSalary` is emitted only when a figure is actually
  present; nothing is inferred.
- **Postings are single-language**, authored in whichever language the
  recruiter used. Only the UI shell is translated (Paraglide
  `careers_*` keys). `category` is the one bilingual field, and chips
  pick `name_en`/`name_th` from the route locale.
- **`currency` defaults to THB** when the feed omits it.

## Resilience

The marketing site must never 500 because the ATS is down, so
`loadCareersFeed()` cannot reject. It degrades through four states:

| Status        | Meaning                                             |
| ------------- | --------------------------------------------------- |
| `live`        | Fresh response from upstream                        |
| `cached`      | KV entry inside the 300s TTL — no network call made |
| `stale`       | Upstream failed; serving a KV entry up to 24h old   |
| `unavailable` | Upstream failed and no cache exists — empty state   |

`unavailable` renders the same friendly "no open positions right now"
page as a genuinely empty feed, at HTTP 200. The page stays indexable
and linkable with zero openings.

Upstream calls are bounded by a 4s timeout (`CAREERS_FETCH_TIMEOUT_MS`)
— a hung ATS must not hang the page render. A garbled 200 (HTML error
page, truncated JSON) is treated as an outage and does **not** overwrite
good cached jobs.

Tuning constants live at the top of `service.ts`.

## Security

The feed is untrusted third-party JSON.

- Feed text is rendered as **text only** — there is no `{@html}`
  anywhere in the careers route, and no HTML sanitizer, because none is
  needed at a text-only boundary.
- `apply_url` is scheme-checked to http(s) in `safeUrl()`. A
  `javascript:` or `data:` URL causes the whole job to be dropped, so it
  can never reach an `href`.
- JSON-LD escapes `<` on the serialized string (same guard as
  `shop/jsonld.ts`), so a `</script>` in a job title cannot break out of
  the structured-data block.
- Cache entries are re-normalized on read, so a tampered KV value gets
  the same validation as a fresh fetch.

## Files

| File         | Role                                                       |
| ------------ | ---------------------------------------------------------- |
| `feed.ts`    | Pure parsing/normalization of untrusted feed JSON          |
| `service.ts` | Fetch + timeout + KV cache + stale-on-error (impure shell) |
| `jsonld.ts`  | `JobPosting` structured data                               |
| `index.ts`   | Plugin registration                                        |

The route lives at `src/routes/(www)/[locale]/careers/`.

`feed.ts` and `jsonld.ts` are network-free, so the whole contract is
unit-tested without mocking a server; `service.ts` takes injected
`fetchImpl`/`now` for the same reason.

## Not implemented yet

The feed's list endpoint omits `description`/`requirements`, so there is
no per-opening detail page — cards link straight to `apply_url`. When
the upstream detail endpoint lands (codustry/workflow#937), add
`careers/[id]/` and pass `description` into `buildJobPostingJsonLd`,
which already accepts it.
