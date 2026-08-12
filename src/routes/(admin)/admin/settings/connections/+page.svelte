<script lang="ts">
  import { resolve } from "$app/paths";
  import { Plug } from "lucide-svelte";
  import { PageShell, PageHeader, StatusBadge } from "$lib/components/admin";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const paired =
    data.apiKeyConfigured && data.webhookSecretConfigured;
</script>

<svelte:head><title>Connections — Khao Pad</title></svelte:head>

<PageShell width="form">
  <PageHeader
    title="Connections"
    description="Pair Khao Pad with the Tonbab POS. Tonbab pushes its sales here; lifecycle events flow back out through webhooks."
    icon={Plug}
    breadcrumbs={[
      { label: "Settings", href: resolve("/(admin)/admin/settings") },
      { label: "Connections" },
    ]}
  />

  {#if !data.platformReady}
    <div
      class="rounded-md border border-amber-300 bg-amber-100 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
    >
      Database binding unavailable — connection status cannot be read.
    </div>
  {:else}
    <!-- Live status -->
    <section class="mb-8">
      <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide">
        Tonbab POS — status
      </h2>
      <div class="rounded-lg border border-border p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Pairing</p>
            <p class="mt-0.5 text-xs text-muted-foreground">
              Both Tonbab-minted credentials must be stored before inbound
              sync works.
            </p>
          </div>
          {#if paired}
            <StatusBadge
              status="paired"
              tone="success"
              label="Paired"
              class="shrink-0"
            />
          {:else}
            <StatusBadge
              status="not_paired"
              tone="neutral"
              label="Not paired"
              class="shrink-0"
            />
          {/if}
        </div>

        <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div class="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
            <dt class="font-mono text-xs">TONBAB_WEBHOOK_SECRET</dt>
            <dd>
              {#if data.webhookSecretConfigured}
                <StatusBadge status="ok" tone="success" label="Configured" />
              {:else}
                <StatusBadge status="missing" tone="danger" label="Not set" />
              {/if}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
            <dt class="font-mono text-xs">TONBAB_API_KEY</dt>
            <dd>
              {#if data.apiKeyConfigured}
                <StatusBadge status="ok" tone="success" label="Configured" />
              {:else}
                <StatusBadge status="missing" tone="neutral" label="Not set" />
              {/if}
            </dd>
          </div>
        </dl>

        <div class="mt-4 border-t border-border pt-3 text-sm">
          {#if data.lastSync}
            <p>
              Last sync: <span class="font-medium">{data.lastSync.action}</span>
              → {data.lastSync.result}
              {#if data.lastSync.detail}({data.lastSync.detail}){/if}
              <span class="text-muted-foreground">
                at {new Date(data.lastSync.at).toLocaleString()}</span
              >
            </p>
          {:else}
            <p class="text-muted-foreground">No sync activity yet.</p>
          {/if}
          <p class="mt-1 text-xs text-muted-foreground">
            {data.totalCount} item{data.totalCount === 1 ? "" : "s"} processed
            {#if data.errorCount > 0}
              · <span class="text-red-600 dark:text-red-400"
                >{data.errorCount} error{data.errorCount === 1 ? "" : "s"}</span
              >
            {/if}
          </p>
        </div>
      </div>
    </section>

    <!-- Pairing guide -->
    <section class="mb-8">
      <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide">
        How to pair (Beam model)
      </h2>
      <ol class="list-decimal space-y-3 pl-5 text-sm">
        <li>
          In <strong>Tonbab</strong>, open Settings → Khao Pad sync and start
          pairing. Tonbab mints <em>both</em> credentials — an API key (for
          future Khao Pad → Tonbab calls) and a webhook secret (signs
          Tonbab's pushes to Khao Pad).
        </li>
        <li>
          Paste both values into
          <a
            class="underline underline-offset-2"
            href={resolve("/(admin)/admin/settings/secrets")}
            >Integration credentials</a
          >
          under the <strong>Tonbab sync</strong> group (super-admin only —
          they are stored encrypted and never shown again).
        </li>
        <li>
          Give Tonbab this inbound endpoint URL:
          <code
            class="mt-1 block w-fit rounded bg-muted px-2 py-1 font-mono text-xs"
            >{data.endpointUrl}</code
          >
        </li>
        <li>
          Tonbab signs every push: HMAC-SHA256 over the raw request body
          with the webhook secret, base64 digest in the
          <code class="rounded bg-muted px-1 font-mono text-xs"
            >X-Tonbab-Signature</code
          >
          header. Unsigned or mis-signed requests are rejected with 401;
          until the secret is stored the endpoint answers 503.
        </li>
      </ol>
      <p class="mt-3 text-xs text-muted-foreground">
        POS sales arrive as paid orders on the <code
          class="rounded bg-muted px-1 font-mono">tonbab_pos</code
        > channel with totals exactly as Tonbab recorded them. Conflicting
        transitions resolve last-write-wins. Full contract: docs/tonbab-sync.md.
      </p>
    </section>
  {/if}
</PageShell>
