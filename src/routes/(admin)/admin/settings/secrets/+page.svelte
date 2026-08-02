<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { KeyRound } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { PageShell, PageHeader, StatusBadge } from "$lib/components/admin";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const statusFor = (key: string) => data.statuses.find((s) => s.key === key);
</script>

<svelte:head><title>Integration credentials — Khao Pad</title></svelte:head>

<PageShell width="form">
  <PageHeader
    title="Integration credentials"
    description="API keys for payments and email. Stored encrypted; never shown again after saving."
    icon={KeyRound}
    breadcrumbs={[
      { label: "Settings", href: resolve("/(admin)/admin/settings") },
      { label: "Integration credentials" },
    ]}
  />

  {#if !data.platformReady}
    <div
      class="rounded-md border border-amber-300 bg-amber-100 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
    >
      Database binding unavailable — credentials cannot be read or stored.
    </div>
  {:else}
    {#if !data.hasMasterSecret}
      <div
        class="mb-6 rounded-md border border-red-300 bg-red-100 p-4 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300"
      >
        <strong>BETTER_AUTH_SECRET is not set.</strong> It is the key-derivation
        root for encrypting these values, so nothing can be saved until it exists.
        Set it as a Cloudflare secret:
        <code class="mt-2 block font-mono text-xs"
          >npx wrangler secret put BETTER_AUTH_SECRET</code
        >
      </div>
    {/if}

    {#if form?.error}
      <div
        class="mb-4 rounded-md border border-red-300 bg-red-100 p-3 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300"
      >
        {form.error}
      </div>
    {:else if form?.success}
      <div
        class="mb-4 rounded-md border border-green-300 bg-green-100 p-3 text-sm text-green-800 dark:border-green-500/40 dark:bg-green-500/15 dark:text-green-300"
      >
        {form.removed ? "Removed" : "Saved"}
        {form.key}. Takes effect on the next request.
      </div>
    {/if}

    {#each data.groups as group (group.name)}
      <section class="mb-8">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide">
          {group.name}
        </h2>

        <div class="space-y-4">
          {#each group.defs as def (def.key)}
            {@const status = statusFor(def.key)}
            <div class="rounded-lg border border-border p-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <label for={def.key} class="text-sm font-medium">
                    {def.label}
                  </label>
                  <p class="mt-0.5 font-mono text-xs text-muted-foreground">
                    {def.key}
                  </p>
                </div>

                {#if status?.source === "env"}
                  <StatusBadge
                    status="env"
                    tone="info"
                    label="Set in Cloudflare"
                    class="shrink-0"
                  />
                {:else if status?.undecryptable}
                  <StatusBadge
                    status="undecryptable"
                    tone="danger"
                    label="Cannot decrypt"
                    class="shrink-0"
                  />
                {:else if status?.configured}
                  <StatusBadge
                    status="configured"
                    tone="success"
                    label="Configured"
                    class="shrink-0"
                  />
                {:else}
                  <StatusBadge
                    status="not_set"
                    tone="neutral"
                    label="Not set"
                    class="shrink-0"
                  />
                {/if}
              </div>

              <p class="mt-2 text-xs text-muted-foreground">{def.help}</p>

              {#if status?.preview}
                <p class="mt-2 font-mono text-xs">
                  Current: <span class="rounded bg-muted px-1.5 py-0.5"
                    >{status.preview}</span
                  >
                </p>
              {/if}

              {#if status?.undecryptable}
                <p class="mt-2 text-xs text-red-700 dark:text-red-300">
                  A value is stored but could not be decrypted — this happens
                  when BETTER_AUTH_SECRET is rotated. Re-enter the value below.
                </p>
              {/if}

              {#if status?.source === "env"}
                <p class="mt-3 text-xs text-muted-foreground">
                  This value comes from a Cloudflare environment variable, which
                  takes precedence over anything stored here. Remove the env var
                  to manage it from this page.
                </p>
              {:else}
                <form
                  method="POST"
                  action="?/save"
                  use:enhance
                  class="mt-3 flex gap-2"
                >
                  <input type="hidden" name="key" value={def.key} />
                  <input
                    id={def.key}
                    name="value"
                    type={def.sensitive ? "password" : "text"}
                    autocomplete="off"
                    placeholder={status?.configured
                      ? "Enter a new value to replace"
                      : "Paste value"}
                    class="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    disabled={!data.hasMasterSecret}
                  />
                  <Button type="submit" size="sm" disabled={!data.hasMasterSecret}>
                    Save
                  </Button>
                </form>

                {#if status?.configured || status?.undecryptable}
                  <form method="POST" action="?/remove" use:enhance class="mt-2">
                    <input type="hidden" name="key" value={def.key} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      class="h-auto px-0 text-xs text-destructive hover:bg-transparent hover:underline"
                    >
                      Remove stored value
                    </Button>
                  </form>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}

    <section class="mt-10 rounded-lg border border-dashed border-border p-4">
      <h2 class="text-sm font-semibold">Managed in Cloudflare only</h2>
      <p class="mt-2 text-xs text-muted-foreground">
        <code class="font-mono">BETTER_AUTH_SECRET</code> cannot be moved here.
        It is read on every request to validate the session — before we know who
        you are — so storing it behind this page would be circular. It also signs
        session cookies, meaning anything able to read it could forge a login as
        any user.
      </p>
      <p class="mt-2 text-xs text-muted-foreground">
        <code class="font-mono">CLOUDFLARE_API_TOKEN</code> and
        <code class="font-mono">CLOUDFLARE_ACCOUNT_ID</code> are deploy-time
        credentials used to create the Worker, so they cannot live inside it.
      </p>
    </section>
  {/if}
</PageShell>
