# Khao Pad — Notes for docs.khaopad.com

This folder is a **scratchpad for future documentation**, not a polished docs site. Each file is a long-form note on one architectural topic — the kind of thing that takes a paragraph to answer on Slack and is worth writing down once.

Eventually these become chapters on `docs.khaopad.com` (domain TBD). For now they live next to the code so they drift less.

## Index

| File                                     | Topic                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BETTERAUTH.md](./BETTERAUTH.md)         | How Better Auth is wired: construction, handler catchall, session hook, role permissions, bootstrap dance.                                                     |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | The big picture: subdomain routing via hooks, route-group split, request lifecycle, why Workers not Pages.                                                     |
| [CONTENT-MODEL.md](./CONTENT-MODEL.md)   | ContentProvider interface, D1 vs GitHub mode, slug rules, localization storage, the EN-required invariant.                                                     |
| [I18N.md](./I18N.md)                     | Two independent i18n layers: Paraglide (UI shell, compile-time) vs content localizations (runtime, per-locale markdown). Why they don't overlap.               |
| [DEPLOYMENT.md](./DEPLOYMENT.md)         | Config layers (bindings, vars, CF secrets, GH secrets), the 503 guard, local-dev vs prod, Wrangler simulators.                                                 |
| [PLATFORM-NOTES.md](./PLATFORM-NOTES.md) | Cloudflare-specific gotchas: D1 has no interactive transactions, Workers has no filesystem, Vite 5 pin, `nodejs_compat` flag, why `createAuth` is per-request. |
| [MIGRATING.md](./MIGRATING.md)           | Folding an existing SvelteKit app into Khao Pad: where your routes/components/API/DB go, conflicts to expect, decision tree for "which folder?".               |

## Conventions

- **Code-first.** Every claim should link to a real file path and function/export. If the code moves, the note is stale — grep for the path before relying on it.
- **Why, not what.** The code already tells you what happens. These notes exist to explain _why_ a decision was made and what alternative we rejected.
- **Short paragraphs, diagrams where they help.** ASCII diagrams beat prose for request flows and layered architectures.
- **Date the last touch** at the bottom of each note. Fresh-looking docs that are 18 months stale are worse than no docs.

## When a note graduates to docs.khaopad.com

A file is ready to publish when:

1. It compiles in your head without having to reread the code it describes.
2. Every file path in it still exists (run `grep -h 'src/' docs/*.md | ...`).
3. A new engineer can act on it without asking follow-up questions on Slack.

Until then, leave a `> **Status: draft**` banner at the top so readers know.
