# Telemetry

Khao Pad can send a small, completely anonymous ping to its maintainers once a week, so they can see how many installs exist and which versions are in the wild.

**It is off by default.** A fresh install sends nothing, forever, until someone switches it on. If you never touch the setting, you can stop reading here.

## Turning it on

**Settings → Anonymous usage data → Send anonymous usage data.**

That is the whole thing. It takes effect on the next weekly cron tick; no redeploy.

## Turning it off

Three independent ways, any one of which is sufficient:

1. Untick the same box in **Settings → Anonymous usage data**.
2. Set `KHAOPAD_TELEMETRY_DISABLED=1` in your Worker environment. This is a **hard veto** — it wins over the setting, so if you administer a fleet you can guarantee silence from your deploy config without touching anyone's admin UI.
3. Remove `TELEMETRY_ENDPOINT` from your `[vars]`. With nowhere to send, nothing is sent.

## What is sent

Exactly these fields, and nothing else. The list is pinned by a test (`telemetry-payload.node.test.ts`), so a field cannot be added without this document going stale in a way CI will not catch — the test asserts the key set, and a reviewer is on the hook for the prose.

| Field              | Example                  | Why                                                                                                                     |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `payloadVersion`   | `"1"`                    | Schema version, so the collector can read old pings after a change.                                                     |
| `installId`        | `"V1StGXR8_Z5jdHi6B-my"` | A random id identifying **an install**. See below — this is the field that matters.                                     |
| `engineVersion`    | `"4.5.0"`                | Which release you are on. Answers "can we drop support for 3.x yet?"                                                    |
| `contractVersion`  | `"1.0.0"`                | Theme-contract version, for the same reason.                                                                            |
| `runtime`          | `"cloudflare-workers"`   | A fixed label. Not a version, not a path, not a hostname.                                                               |
| `plugins`          | `["shop"]`               | Which **optional** plugins are switched on. Engine-defined slugs only — never your own plugin names, never your config. |
| `localeCount`      | `2`                      | How many locales the site serves. A number, never which ones.                                                           |
| `buckets.articles` | `"11-100"`               | Rough content scale. One of `0`, `1-10`, `11-100`, `100+`.                                                              |
| `buckets.pages`    | `"1-10"`                 | Same.                                                                                                                   |
| `buckets.users`    | `"1-10"`                 | Same.                                                                                                                   |
| `region`           | `"APAC"`                 | Continent, when Cloudflare provides it for free. One of six values.                                                     |

A complete ping is about 250 bytes:

```json
{
  "payloadVersion": "1",
  "installId": "V1StGXR8_Z5jdHi6B-my",
  "engineVersion": "4.5.0",
  "contractVersion": "1.0.0",
  "runtime": "cloudflare-workers",
  "plugins": ["shop"],
  "localeCount": 2,
  "buckets": { "articles": "11-100", "pages": "1-10", "users": "1-10" },
  "region": "APAC"
}
```

### Why counts are buckets

`"11-100"` instead of `47` is not vagueness for its own sake. An exact tuple — 847 articles, 23 pages, 4 users — is a **fingerprint**. It is close to unique across a population of sites, and it lets an observer re-identify the same install across pings even with the id stripped, and correlate it against any other dataset where those numbers are visible. `11-100` answers the maintainer's real question ("is this a real site or an empty fork?") and identifies nobody.

The same reasoning downgrades country to continent. `TH` plus `["shop"]` plus a bucket tuple narrows a site much further than `APAC` does.

## What is never sent

Not "we promise not to look at" — not collected, not transmitted, and rejected by the collector if it ever arrived:

- Your site's **URL, domain, or hostname**. Not in the payload, not in a header.
- Your **IP address**. The collector never reads `cf-connecting-ip`, never logs it, and has no column for it.
- Any **user data** — no ids, names, emails, roles, session or auth data.
- Any **content** — no articles, titles, slugs, media, products, orders, prices, or customer data.
- Any **secrets or infrastructure ids** — no D1/R2/KV ids, no API keys, no env vars.
- Any **visitor analytics**. This is unrelated to your site's own traffic stats.
- **Exact counts** of anything.

## The install id

`installId` is a random 21-character `nanoid`, generated once on your install and stored in your own site settings.

It is **not derived from anything about you**. That distinction carries more weight than it first appears. The obvious shortcut — hash the domain, call it anonymous — is not anonymous at all: the set of live Khao Pad domains is small and enumerable, so anyone holding the hashes could dictionary-attack them back to real sites in seconds. A random id has no preimage to recover, from us or from anyone who obtains the database.

It identifies an install, not a person and not a domain. It exists so that a thousand weekly pings from one site count as one install rather than a thousand. Delete the `telemetry.installId` row from your `site_settings` and you become a new, unlinkable install.

## When it is sent

From the **weekly cron tick only** — `/api/telemetry/cron`, guarded by `CRON_SECRET` like the shop sweep.

Never from a page render, an admin action, a build, or a deploy. No visitor and no editor ever waits on it, and a slow or dead collector cannot surface as a slow site. The request has a hard 3-second timeout and every failure path is swallowed: if telemetry breaks, the outcome is that no data was collected, never an error page.

## Where it goes

To a collector Worker run by Codustry, the Khao Pad maintainers. Its complete source is public at [`codustry/khaopad-telemetry`](https://github.com/codustry/khaopad-telemetry) — the endpoint, the schema, and the allow-list that rejects anything it does not recognise.

The collector lives in its own repository rather than in this one on purpose. Khao Pad is the engine every fork merges from, and the maintainers' analytics backend is not code your site should have to carry, review, or merge around.

Aggregate figures may be shared publicly ("N installs, M on 4.x"). Individual rows are not, and there is nothing in a row that would identify you if they were.

## Why this design

The two prior arts here are not equally good, and Khao Pad deliberately copies one of them.

**WordPress** appends your site's URL to the User-Agent of every update check, with no opt-out. The practice has been contested since 2011 ([core.trac.wordpress.org #16778](https://core.trac.wordpress.org/ticket/16778)) and a plugin exists whose entire purpose is stripping it. It means WordPress.org holds a live map of which URL runs which version of which plugins — a list that is a security liability for the sites on it. Khao Pad does not do this.

**Next.js** and **Astro** set the standard this document is written against: anonymous by construction, aggregate-only, documented field by field, disabled with one env var, and never traceable back to a source. That is what is implemented here.

One place Khao Pad goes further than either: **the default is off**, where theirs are on. Khao Pad forks are typically commercial client sites — an agency builds on the engine, and the business running the site never chose it. Enabling by default would mean the engine phoning home from someone's production deployment on a decision they were never party to. Opting in costs the maintainers some sample size; it costs an operator nothing, and it means every ping received is one somebody actually agreed to send.

If you are running Khao Pad and it is working for you, turning this on is genuinely useful — it is the only signal the maintainers get.
