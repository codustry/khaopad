/**
 * Mask an email for in-CMS display. `alice@example.com` →
 * `a***@e***.com`. Pure helper, safe to import client-side.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return email;
  const localPart = email.slice(0, at);
  const domainPart = email.slice(at + 1);
  const dot = domainPart.lastIndexOf(".");
  const tld = dot > 0 ? domainPart.slice(dot) : "";
  const domainHead = dot > 0 ? domainPart.slice(0, dot) : domainPart;
  return `${localPart[0]}***@${domainHead[0]}***${tld}`;
}
