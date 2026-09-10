@php
    $isGrowthPage = str_starts_with($page['component'] ?? '', 'Growth/');
    $seo = $page['props']['seo'] ?? null;
@endphp
<!DOCTYPE html>
<html lang="{{ $isGrowthPage ? 'en' : str_replace('_', '-', app()->getLocale()) }}"  @class(['dark' => ($appearance ?? 'dark') == 'dark'])>
    <head>
        <meta charset="utf-8">
        {{-- viewport-fit=cover makes env(safe-area-inset-*) meaningful inside the
             native mobile shell (frontend/mobile) and installed PWAs. --}}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <meta name="theme-color" content="#0b0f10">
        <meta name="application-name" content="{{ config('app.name', 'Cyberia') }}">
        <meta name="mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="apple-mobile-web-app-title" content="{{ config('app.name', 'Cyberia') }}">
        <link rel="manifest" href="/manifest.webmanifest">

        {{-- Inline script to detect system dark mode preference and apply it immediately --}}
        <script>
            (function() {
                const appearance = '{{ $appearance ?? "dark" }}';

                if (appearance === 'system') {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

                    if (prefersDark) {
                        document.documentElement.classList.add('dark');
                    }
                }
            })();
        </script>

        {{-- Inline style to set the HTML background color based on our theme in app.css --}}
        <style>
            html {
                background-color: hsl(0 0% 100%);
            }

            html.dark {
                background-color: hsl(210 15% 4%);
            }
        </style>

        <link rel="icon" href="/favicon.ico" sizes="any">
        <link rel="icon" href="/favicon.svg" type="image/svg+xml">
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">

        <link rel="preconnect" href="https://fonts.bunny.net">
        {{-- Manrope is the site face; Space Grotesk and IBM Plex Mono are the
             wallet's; Archivo is the operator console's, where dense rows of
             labels need a narrower grotesque and it carries Cyrillic, which
             the console is mostly read in. Space Grotesk has no Cyrillic, so
             Russian copy falls back to Manrope by design — the mono face
             carries both alphabets.

             display=swap matters more here than it looks: without it the
             browser hides text for up to three seconds while the font loads,
             which on a slow phone means a wallet whose buttons and balances
             are blank. Fallback text now paints immediately and swaps. --}}
        <link href="https://fonts.bunny.net/css?family=manrope:300,400,500,600,700,800|space-grotesk:400,500,600,700|archivo:400,500,600,700|ibm-plex-mono:400,500,600&display=swap" rel="stylesheet" />

        @vite(['resources/css/app.css', 'resources/js/app.ts', "resources/js/pages/{$page['component']}.vue"])
        @if (is_array($seo))
            <title data-inertia="">{{ $seo['title'] }}</title>
            <meta data-inertia="description" name="description" content="{{ $seo['description'] }}">
            <link data-inertia="canonical" rel="canonical" href="{{ $seo['canonical'] }}">
            <meta data-inertia="og:title" property="og:title" content="{{ $seo['title'] }}">
            <meta data-inertia="og:description" property="og:description" content="{{ $seo['description'] }}">
            <meta data-inertia="og:url" property="og:url" content="{{ $seo['canonical'] }}">
            <meta data-inertia="og:type" property="og:type" content="website">
            <meta data-inertia="og:image" property="og:image" content="{{ $seo['image'] }}">
            <meta data-inertia="twitter:card" name="twitter:card" content="summary_large_image">
            <meta data-inertia="twitter:title" name="twitter:title" content="{{ $seo['title'] }}">
            <meta data-inertia="twitter:description" name="twitter:description" content="{{ $seo['description'] }}">
            <script data-inertia="faq-json" type="application/ld+json">{!! json_encode($seo['structuredData'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) !!}</script>
        @else
            {{-- `data-inertia` is what makes this title a *default* rather than a
                 second one. Inertia's head manager only ever removes elements
                 carrying that attribute; an untagged <title> stays in the head
                 forever, in front of the one every page sets through <Head>,
                 and the browser honours the first. Which is why the wallet, the
                 swap and everything else were all called "Singularity" in the
                 tab, the history and the bookmarks whatever their own title
                 said. The $seo branch above has always tagged its own. --}}
            <x-inertia::head>
                <title data-inertia="">{{ config('app.name', 'Laravel') }}</title>
            </x-inertia::head>
        @endif
    </head>
    <body class="font-sans antialiased">
        <x-inertia::app />
    </body>
</html>
