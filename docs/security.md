# Security posture

Khao Pad ships single-host: public content at `/` and admin at `/admin/*` share the same origin. That makes the primary threat model **stored-XSS in user-generated content on the public surface exfiltrating admin cookies**, not cross-origin CSRF. Every defense below serves that model.

## Session cookie

Configured in `src/lib/server/auth/index.ts`. In production:

- **Name**: `__Host-khaopad_session`
- **`Secure`**: `true` (HTTPS-only)
- **`HttpOnly`**: `true` (not readable from `document.cookie`)
- **`SameSite`**: `Lax` (sent on top-level navigations, blocked on cross-site subresources)
- **`Path`**: `/`
- **`Domain`**: not set → host-only (cookie only sent to the exact origin)
- **`__Host-` prefix**: browser enforces `Secure=true`, `Path=/`, no `Domain` — a rogue subdomain (if one is ever added) cannot set a cookie with this name

### Why `__Host-` over `__Secure-`

Better Auth's default in production is `__Secure-better-auth.session_token`. `__Secure-` mandates `Secure=true` but permits `Domain` and `Path` variations. `__Host-` additionally forbids `Domain` and mandates `Path=/` — the browser refuses to store the cookie unless those hold.

Practical effect: if someone ever spins up `blog.example.com` next to `example.com`, they _cannot_ set a cookie named `__Host-khaopad_session` targeting the admin. This is belt-and-braces against a future architectural change (see [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and RFC 6265bis §4.1.3.2).

## Content Security Policy

Configured in `src/hooks.server.ts` (`securityHeadersHook`). Two policies, one per surface:

### Public (`/`, not `/admin/*`)

```
default-src 'self';
script-src 'self';                  # no inline scripts — kills the primary XSS vector
style-src 'self' 'unsafe-inline';   # svelte hydration needs per-component style attributes
img-src 'self' data: blob: https:;  # data: for markdown-embedded, https: for R2 + external images
media-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self';                 # comments + newsletter fetch, no external APIs
frame-ancestors 'none';             # clickjacking defense
form-action 'self';
base-uri 'self';
object-src 'none';
```

### Admin (`/admin/*`)

Same as public. Admin is authenticated, so the primary threat class differs (a hostile admin has legitimate write access; CSP doesn't help there). Kept strict as defense-in-depth in case an author account is compromised.

### Notable strictness choices

- **`script-src 'self'` (no `unsafe-inline` or `unsafe-eval`)**: This is the single most impactful anti-XSS control. A stored `<script>alert(document.cookie)</script>` in a comment body simply doesn't execute. If a specific external script is ever needed, add its origin explicitly — never fall back to `'unsafe-inline'`.
- **`frame-ancestors 'none'`** (+ `X-Frame-Options: DENY`): admin cannot be framed, so clickjacking-driven state changes are blocked.
- **`connect-src 'self'`**: no external fetch. If analytics ever ships (e.g. PostHog Cloud), extend this to include the analytics origin explicitly.

## Other headers

- `X-Content-Type-Options: nosniff` — blocks MIME sniffing (used for JS-served-as-HTML attacks)
- `Referrer-Policy: strict-origin-when-cross-origin` — narrows referrer leakage on outbound clicks
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` — denies feature-policy APIs we never use
- `X-Frame-Options: DENY` — legacy anti-framing (paired with `frame-ancestors 'none'` for browsers that respect only one)

HSTS is set by Cloudflare in front of the Worker; not managed here.

## What's NOT in scope

- **CSRF tokens for admin forms** — SvelteKit form actions POST to the same origin; `SameSite=Lax` blocks the cross-site CSRF vector cheaply. If we ever add cross-origin admin APIs, revisit.
- **Rate limiting** — handled at Cloudflare edge (WAF rules), not framework
- **DDoS** — Cloudflare edge
- **2FA** — not implemented; deferred until v3.x if requested
- **Session revocation UI** — Better Auth stores sessions in D1; a "log out everywhere" UI would query `sessions` table but isn't wired

## Threats considered

| Threat                                                                 | Mitigation                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Stored XSS in comment body → steal admin cookie                        | `HttpOnly` on cookie + `script-src 'self'` CSP                                    |
| Stored XSS in article body (author-authored)                           | Same as above; author trust boundary applies                                      |
| Sibling-subdomain cookie tossing (if `www.` or `admin.` is ever added) | `__Host-` prefix mandates host-only                                               |
| Clickjacking of admin actions                                          | `frame-ancestors 'none'` + `X-Frame-Options: DENY`                                |
| CSRF against admin form actions                                        | `SameSite=Lax` cookie + same-origin form-action CSP                               |
| MIME sniffing (JS-as-HTML)                                             | `X-Content-Type-Options: nosniff`                                                 |
| Referrer leaking session URL params                                    | `Referrer-Policy: strict-origin-when-cross-origin` (and no session-in-URL anyway) |
| Domain takeover of a forgotten subdomain                               | Not us to fix, but `__Host-` cookie means the takeover doesn't get the session    |
| Sensor/payment/mic API abuse from injected content                     | `Permissions-Policy` denies these                                                 |
| SQL injection                                                          | Drizzle parameterized queries — never string-interpolate SQL                      |

## Verifying in a deployed Worker

```bash
# From your machine, hit the deployed URL and inspect headers
curl -sI https://khaopad-example.codustry.workers.dev/ | grep -iE 'csp|content-security|x-frame|x-content|referrer|permissions'
curl -sI https://khaopad-example.codustry.workers.dev/admin/login | grep -iE 'csp|content-security|x-frame|x-content|referrer|permissions'
```

Session cookie inspection (browser devtools → Application → Cookies):

- Name: `__Host-khaopad_session`
- `HttpOnly` ✓, `Secure` ✓, `SameSite` = Lax
- Domain column: empty (host-only)
- Path: `/`
