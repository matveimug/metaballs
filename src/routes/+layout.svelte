<script>
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();

	const tabs = [
		{ href: '/editor', label: 'Editor' },
		{ href: '/pattern', label: 'Pattern' },
		{ href: '/socials', label: 'Socials' }
	];

	function isActive(href, pathname) {
		return pathname === href || pathname.startsWith(`${href}/`);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app-shell">
	<nav class="tabs" aria-label="Main tabs">
		{#each tabs as tab}
			<a class:active={isActive(tab.href, page.url.pathname)} href={tab.href}>{tab.label}</a>
		{/each}
	</nav>

	<main class="content">{@render children()}</main>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #f3f4f6;
		color: #111827;
	}

	.app-shell {
		min-height: 100vh;
	}

	.tabs {
		display: flex;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		background: #ffffff;
		border-bottom: 1px solid #e5e7eb;
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.tabs a {
		text-decoration: none;
		color: #4b5563;
		font-weight: 600;
		padding: 0.45rem 0.7rem;
		border-radius: 0.5rem;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.tabs a:hover {
		background: #f3f4f6;
		color: #1f2937;
	}

	.tabs a.active {
		background: #111827;
		color: #ffffff;
	}

	.content {
		min-height: calc(100vh - 68px);
	}
</style>
