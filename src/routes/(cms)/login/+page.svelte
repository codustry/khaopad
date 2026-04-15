<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	async function handleLogin(e: Event) {
		e.preventDefault();
		loading = true;
		error = '';

		try {
			const res = await fetch('/api/auth/sign-in/email', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
			});

			if (!res.ok) {
				const data = await res.json();
				error = data.message ?? 'Login failed';
				return;
			}

			window.location.href = '/dashboard';
		} catch {
			error = 'Something went wrong';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Login — Khao Pad CMS</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<h1 class="text-2xl font-bold">🍳 Khao Pad CMS</h1>
			<p class="text-muted-foreground text-sm mt-2">Sign in to manage content</p>
		</div>

		<form onsubmit={handleLogin} class="space-y-4">
			{#if error}
				<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
					{error}
				</div>
			{/if}

			<div>
				<label for="email" class="block text-sm font-medium mb-1">Email</label>
				<input
					id="email"
					type="email"
					bind:value={email}
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					placeholder="admin@example.com"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm font-medium mb-1">Password</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
			>
				{loading ? 'Signing in...' : 'Sign in'}
			</button>
		</form>
	</div>
</div>
