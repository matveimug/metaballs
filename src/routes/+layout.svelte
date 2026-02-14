<script>
  import favicon from "$lib/assets/favicon.svg";
  import { page } from "$app/state";
  import "$lib/styles/metaballs-shared.css";

  let { children } = $props();

  const tabs = [
    { href: "/editor", label: "Editor" },
    { href: "/pattern", label: "Pattern" },
    { href: "/socials", label: "Socials" },
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
      <a class:active={isActive(tab.href, page.url.pathname)} href={tab.href}
        >{tab.label}</a
      >
    {/each}
  </nav>

  <div class="content">{@render children()}</div>
</div>
