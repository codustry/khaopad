export type LoginSubmitResult = { ok: true } | { ok: false; error: string };

export const submitEmailLogin = async (
  e: SubmitEvent,
  creds: { email: string; password: string },
): Promise<LoginSubmitResult> => {
  e.preventDefault();

  const res = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });

  if (!res.ok) {
    const raw = await res.json();
    const msg =
      raw && typeof raw === "object" && "message" in raw
        ? Reflect.get(raw, "message")
        : undefined;
    return {
      ok: false,
      error: typeof msg === "string" ? msg : "Login failed",
    };
  }

  return { ok: true };
};
