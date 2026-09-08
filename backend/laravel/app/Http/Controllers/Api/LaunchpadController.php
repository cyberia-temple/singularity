<?php

namespace App\Http\Controllers\Api;

use App\Actions\Wallet\RecoverEvmAddress;
use App\Http\Controllers\Controller;
use App\Models\LaunchpadToken;
use App\Services\IpfsService;
use App\Services\LaunchpadSiteService;
use App\Support\Handles;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class LaunchpadController extends Controller
{
    public function __construct(
        private readonly RecoverEvmAddress $recoverEvmAddress,
        private readonly LaunchpadSiteService $sites,
        private readonly IpfsService $ipfs,
    ) {}

    /** Return metadata for every token registered with the Launchpad. */
    public function index(): JsonResponse
    {
        $tokens = LaunchpadToken::orderByDesc('created_at')->get()->map(function (LaunchpadToken $t) {
            return $this->serialize($t);
        });

        return response()->json(['tokens' => $tokens]);
    }

    /**
     * Save off-chain metadata for a launched token. Gated on a personal-sign
     * signature by the token's creator (first signer wins; after that, only
     * that address can edit).
     */
    public function store(Request $request): JsonResponse
    {
        $addressInput = $request->input('address');
        $subdomainInput = $request->input('site_subdomain');
        $request->merge([
            'address' => is_string($addressInput) ? Str::lower($addressInput) : $addressInput,
            'site_subdomain' => is_string($subdomainInput) && trim($subdomainInput) !== ''
                ? Str::lower(trim($subdomainInput))
                : null,
        ]);

        $data = $request->validate([
            'address' => ['required', 'string', 'regex:/^0x[a-fA-F0-9]{40}$/'],
            'chain_id' => ['nullable', 'integer', Rule::in(array_keys(config('launchpad.chains')))],
            'message' => ['required', 'string', 'max:500'],
            'signature' => ['required', 'string', 'regex:/^0x[a-fA-F0-9]{130}$/'],
            'name' => ['nullable', 'string', 'max:100'],
            'symbol' => ['nullable', 'string', 'max:32'],
            'description' => ['nullable', 'string', 'max:2000'],
            // Taken as typed — a handle, an @handle or a pasted profile URL —
            // and collapsed to the bare handle on the way in.
            'x' => ['nullable', 'string', 'max:200'],
            'telegram' => ['nullable', 'string', 'max:200'],
            'website' => ['nullable', 'string', 'max:255', 'url'],
            'image' => ['nullable', 'image', 'max:2048'],
            'html' => ['nullable', 'file', 'mimes:html,htm,txt', 'max:2048'],
            'site_subdomain' => [
                'nullable',
                'string',
                'max:63',
                'regex:/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/',
                Rule::notIn(config('launchpad.reserved_subdomains')),
            ],
        ]);

        $address = Str::lower($data['address']);
        $message = $data['message'];
        $signature = $data['signature'];
        // Older single-chain clients omit chain_id; their rows are Cyberia.
        $chainId = (int) ($data['chain_id'] ?? config('launchpad.default_chain_id'));

        // 1. Message must reference this token and be recent (replay guard).
        if (! str_contains(Str::lower($message), $address)) {
            return response()->json([
                'message' => 'Signed message must include the token address.',
            ], 422);
        }
        // Multichain clients bind the signature to one chain, so a signature
        // for a Cyberia row cannot be replayed onto a satellite chain row.
        if ($request->filled('chain_id') && ! str_contains(Str::lower($message), 'chain '.$chainId)) {
            return response()->json([
                'message' => 'Signed message must include the chain id.',
            ], 422);
        }
        if (! $this->messageIsFresh($message)) {
            return response()->json([
                'message' => 'Signed message is missing a recent timestamp (within 10 minutes).',
            ], 422);
        }

        // 2. Recover the signer.
        $signer = $this->recoverEvmAddress->handle($message, $signature);
        if (! $signer) {
            return response()->json(['message' => 'Invalid signature.'], 422);
        }
        $signer = Str::lower($signer);

        // 3. Authorize: signer must equal the stored creator. First touch claims
        //    ownership; subsequent edits require a match. Ownership is per
        //    chain — the same address on another chain is another contract.
        $existing = LaunchpadToken::where('chain_id', $chainId)->where('address', $address)->first();
        if ($existing && $existing->creator && Str::lower($existing->creator) !== $signer) {
            return response()->json([
                'message' => 'Only the token creator can edit this metadata.',
            ], 403);
        }

        // Subdomains stay globally unique: they are DNS names, not per-chain.
        $siteSubdomain = $data['site_subdomain'] ?? ($existing->site_subdomain ?? null);
        if ($siteSubdomain && LaunchpadToken::where('site_subdomain', $siteSubdomain)
            ->where(fn ($query) => $query
                ->where('chain_id', '!=', $chainId)
                ->orWhere('address', '!=', $address))
            ->exists()) {
            throw ValidationException::withMessages([
                'site_subdomain' => 'This token subdomain is already in use.',
            ]);
        }

        if ($siteSubdomain && ! $request->hasFile('html') && ! $existing?->html_path) {
            return response()->json([
                'message' => 'Upload an HTML page before assigning a token subdomain.',
            ], 422);
        }

        $payload = [
            'chain_id' => $chainId,
            'address' => $address,
            'creator' => $signer, // First signer claims; later edits must match.
            'name' => $data['name'] ?? ($existing->name ?? null),
            'symbol' => $data['symbol'] ?? ($existing->symbol ?? null),
            'description' => $data['description'] ?? ($existing->description ?? null),
            // An empty string is "remove this link" — the field was sent and
            // left blank; an absent field keeps what the row already has.
            'x_handle' => $request->has('x')
                ? Handles::x($data['x'] ?? null)
                : ($existing->x_handle ?? null),
            'telegram_handle' => $request->has('telegram')
                ? Handles::telegram($data['telegram'] ?? null)
                : ($existing->telegram_handle ?? null),
            'website_url' => $request->has('website')
                ? (trim((string) ($data['website'] ?? '')) ?: null)
                : ($existing->website_url ?? null),
            'image_path' => $existing->image_path ?? null,
            'html_path' => $existing->html_path ?? null,
            'site_subdomain' => $siteSubdomain,
        ];

        if ($request->hasFile('image')) {
            if (! empty($payload['image_path'])) {
                Storage::disk('public')->delete($payload['image_path']);
            }
            $payload['image_path'] = $request->file('image')->store('launchpad', 'public');
        }

        if ($request->hasFile('html')) {
            if (! empty($payload['html_path'])) {
                Storage::disk('public')->delete($payload['html_path']);
            }
            $file = $chainId.'-'.$address.'.html';
            Storage::disk('public')->putFileAs('launchpad-sites', $request->file('html'), $file);
            $payload['html_path'] = 'launchpad-sites/'.$file;
            // A CID names bytes: the old one describes the page just replaced.
            $payload['ipfs_cid'] = null;
            $payload['ipfs_pinned_at'] = null;
        }

        $token = LaunchpadToken::updateOrCreate(
            ['chain_id' => $chainId, 'address' => $address],
            $payload,
        );

        // The page is only durable once it has a CID. This pins new uploads and
        // catches up rows that predate pinning; if the node is unreachable the
        // upload still succeeds and `launchpad:pin-sites` finishes the job.
        if ($token->html_path && ! $token->ipfs_cid) {
            $this->sites->publish($token);
        }

        return response()->json(['token' => $this->serialize($token)]);
    }

    /**
     * Serve the static HTML page uploaded for `$address`. Sent with a strict
     * Content-Security-Policy sandbox so it can't touch the main app's cookies
     * or hit same-origin endpoints — arbitrary HTML upload is otherwise an XSS
     * pit.
     */
    public function showSite(string $address): Response
    {
        $token = LaunchpadToken::where('address', Str::lower($address))
            ->whereNotNull('html_path')
            ->first();

        return $this->staticSiteResponse($token);
    }

    /** Serve a token page for every path on its dedicated subdomain. */
    public function showSubdomain(string $subdomain, ?string $path = null): Response
    {
        $token = LaunchpadToken::where('site_subdomain', Str::lower($subdomain))->first();

        return $this->staticSiteResponse($token);
    }

    private function staticSiteResponse(?LaunchpadToken $token): Response
    {
        abort_if(! $token || ! $token->html_path, 404);
        abort_unless(Storage::disk('public')->exists($token->html_path), 404);

        $html = Storage::disk('public')->get($token->html_path);

        $headers = [
            'Content-Type' => 'text/html; charset=UTF-8',
            'Content-Security-Policy' => 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
            'Referrer-Policy' => 'no-referrer',
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
        ];

        // What this host serves is a mirror; the CID is the address that
        // survives it, so say so in the response rather than only in the API.
        if ($token->ipfs_cid) {
            $headers['Link'] = '<'.$this->ipfs->gatewayUrl($token->ipfs_cid).'>; rel="canonical"';
            $headers['X-Ipfs-Cid'] = $token->ipfs_cid;
        }

        return response($html, 200, $headers);
    }

    /** Returns true if the message contains an ISO-ish timestamp not older than 10 min. */
    private function messageIsFresh(string $message): bool
    {
        if (! preg_match('/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/', $message, $m)) {
            return false;
        }
        try {
            $signed = strtotime($m[1]);
        } catch (\Throwable) {
            return false;
        }
        if ($signed === false) {
            return false;
        }

        return abs(time() - $signed) <= 600;
    }

    private function serialize(LaunchpadToken $t): array
    {
        return [
            'chain_id' => (int) $t->chain_id,
            'address' => Str::lower($t->address),
            'creator' => $t->creator ? Str::lower($t->creator) : null,
            'name' => $t->name,
            'symbol' => $t->symbol,
            'description' => $t->description,
            // Both halves travel: the handle is what a page prints, the URL is
            // what it links to, and a value that cannot be a link (a numeric
            // Telegram id) comes back with a null URL rather than a dead one.
            'x_handle' => $t->x_handle,
            'x_url' => Handles::xUrl($t->x_handle),
            'telegram_handle' => $t->telegram_handle,
            'telegram_url' => Handles::telegramUrl($t->telegram_handle),
            'website_url' => $t->website_url,
            'image_url' => $t->image_path ? Storage::disk('public')->url($t->image_path) : null,
            'site_subdomain' => $t->site_subdomain,
            'site_url' => $this->siteUrl($t),
            'ipfs_cid' => $t->ipfs_cid,
            'ipfs_uri' => $t->ipfs_cid ? $this->ipfs->uri($t->ipfs_cid) : null,
            'ipfs_url' => $t->ipfs_cid ? $this->ipfs->gatewayUrl($t->ipfs_cid) : null,
        ];
    }

    private function siteUrl(LaunchpadToken $token): ?string
    {
        if (! $token->html_path) {
            return null;
        }

        if ($token->site_subdomain) {
            return 'https://'.$token->site_subdomain.'.'.config('launchpad.sites_domain').'/';
        }

        // Without a name of its own, a site's primary link is its CID rather
        // than a path on this host — the same page, addressed by content.
        if ($token->ipfs_cid) {
            return $this->ipfs->gatewayUrl($token->ipfs_cid);
        }

        return URL::to('/launchpad/sites/'.Str::lower($token->address));
    }
}
