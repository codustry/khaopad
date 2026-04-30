# Legal-page templates

Drafts you can paste into a Khao Pad **Page** (v1.7b — pages route)
and edit. They are **not** generated automatically because:

1. A privacy policy is a **legal document**. Auto-generated text that
   doesn't match your real data practices can make you liable under
   GDPR, PDPA, CCPA, and similar laws.
2. The required disclosures vary by jurisdiction (Thai PDPA vs EU
   GDPR vs UK DPA vs California CCPA).
3. We can't know your processors, retention periods, or legal entity
   without asking you — so we let you fill them in once, in one place.

## Files

- `privacy-policy.md` — the legal-meaning policy. **Required** if you
  collect any personal data. Replace every `[bracketed placeholder]`.
- `cookie-policy.md` — the technical companion: which cookies the
  stock install sets and what each one does. Update if you add a
  third-party tracker.

## How to ship them

Once Pages land in v1.7b you'll be able to:

```bash
pnpm seed:legal
```

…which creates Page rows from these templates with the placeholders
filled in from `site_settings` (name, contact email).

Until then: copy-paste the markdown into a new article via
`/cms/articles/new`. (Articles aren't ideal for legal pages — they
appear in `/blog` and feeds — so this is genuinely a stopgap.)
