{{--
    The session recorder (resources/js/replay/recorder.ts), behind App\Support\SessionReplay:
    who is never recorded is decided on the server, the visitor's own refusal in the browser.
    Recordings go to this server's /api/replay and nowhere else.

    Then the page counter (Umami on this host, behind App\Support\WebStats), skipped for the
    same people. Its before-send hook is the browser half: the visitor's refusal, the wallet
    installation as the distinct id, and no query parameter but a campaign's.
--}}
@php($replay = \App\Support\SessionReplay::for(request()))
@if ($replay)
<script defer @foreach ($replay as $attribute => $value) {{ $attribute }}="{{ $value }}" @endforeach></script>
@endif
@php($stats = \App\Support\WebStats::for(request()))
@if ($stats)
<script>
window.cyberiaStatsBeforeSend = function (type, payload) {
    try {
        if (localStorage.getItem('cyberia.analytics.optout') === '1') return null;
        var uid = localStorage.getItem('cyberia.analytics.uid');
        if (uid && !payload.id) payload.id = uid;
    } catch (e) {}
    if (payload.url) try {
        var url = new URL(payload.url, location.href), kept = new URLSearchParams();
        url.searchParams.forEach(function (value, key) {
            if (/^(utm_[a-z]+|ref)$/.test(key)) kept.append(key, value);
        });
        url.search = kept.toString();
        url.hash = '';
        payload.url = url.toString();
    } catch (e) {}
    if (payload.referrer) payload.referrer = String(payload.referrer).split(/[?#]/)[0];
    return payload;
};
</script>
<script defer @foreach ($stats as $attribute => $value) {{ $attribute }}="{{ $value }}" @endforeach></script>
@endif
