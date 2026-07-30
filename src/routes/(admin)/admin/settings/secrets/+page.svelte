<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const statusFor = (key: string) => data.statuses.find((s) => s.key === key);
</script>

<svelte:head><title>Integration credentials — Khao Pad</title></svelte:head>

<div class="mx-auto max-w-3xl p-6">
  <header class="mb-6">
    <a
      href={resolve("/(admin)/admin/settings")}
      class="text-sm text-muted-foreground hover:underline">← Settings</a
    >
    <h1 class="mt-2 text-2xl font-semibold">Integration credentials</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      API keys for payments and email. Stored encrypted; never shown again after
      saving.
    </p>
  </header>

  {#if !data.platformReady}
    <div class="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
      Database binding unavailable — credentials cannot be read or stored.
    </div>
  {:else}
    {#if !data.hasMasterSecret}
      <div
        class="mb-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
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
        class="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
      >
        {form.error}
      </div>
    {:else if form?.success}
      <div
        class="mb-4 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900"
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
            <div class="rounded-lg border p-4">
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
                  <span
                    class="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800"
                    >Set in Cloudflare</span
                  >
                {:else if status?.undecryptable}
                  <span
                    class="shrink-0 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800"
                    >Cannot decrypt</span
                  >
                {:else if status?.configured}
                  <span
                    class="shrink-0 rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
                    >Configured</span
                  >
                {:else}
                  <span
                    class="shrink-0 rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                    >Not set</span
                  >
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
                <p class="mt-2 text-xs text-red-700">
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
                    class="flex-1 rounded-md border px-3 py-1.5 text-sm"
                    disabled={!data.hasMasterSecret}
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                    disabled={!data.hasMasterSecret}
                  >
                    Save
                  </button>
                </form>

                {#if status?.configured || status?.undecryptable}
                  <form method="POST" action="?/remove" use:enhance class="mt-2">
                    <input type="hidden" name="key" value={def.key} />
                    <button
                      type="submit"
                      class="text-xs text-red-700 hover:underline"
                    >
                      Remove stored value
                    </button>
                  </form>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}

    <section class="mt-10 rounded-lg border border-dashed p-4">
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
</div>
