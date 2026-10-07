<?php

namespace App\Services\Monitoring;

/**
 * One entry from the registry.
 *
 * `deployed = false` is not a disabled flag: the service stays on the board,
 * stays counted, and is reported `off` with its reason printed. Something the
 * repo carries and nobody ever started is a finding, and deleting it from the
 * list is exactly how it gets forgotten again.
 */
final class ServiceDefinition
{
    /**
     * @param  array<string, mixed>  $check
     * @param  array<string, mixed>|null  $usage
     */
    public function __construct(
        public readonly string $key,
        public readonly string $group,
        public readonly string $label,
        public readonly array $check,
        public readonly ?array $usage = null,
        public readonly bool $critical = false,
        public readonly bool $deployed = true,
        public readonly ?string $url = null,
        public readonly ?string $note = null,
        public readonly ?string $runbook = null,
    ) {}

    /** @param array<string, mixed> $entry */
    public static function fromConfig(string $key, array $entry): self
    {
        return new self(
            key: $key,
            group: (string) ($entry['group'] ?? 'other'),
            label: (string) ($entry['label'] ?? $key),
            check: is_array($entry['check'] ?? null) ? $entry['check'] : ['type' => 'none'],
            usage: is_array($entry['usage'] ?? null) ? $entry['usage'] : null,
            critical: (bool) ($entry['critical'] ?? false),
            deployed: (bool) ($entry['deployed'] ?? true),
            url: isset($entry['url']) ? (string) $entry['url'] : null,
            note: isset($entry['note']) ? (string) $entry['note'] : null,
            runbook: isset($entry['runbook']) ? (string) $entry['runbook'] : null,
        );
    }

    public function checkType(): string
    {
        return (string) ($this->check['type'] ?? 'none');
    }

    /**
     * Whether this service is probed at all. `none` means it has no health of
     * its own to read — a page rendered by the site, a feature whose only
     * failure mode is the site being down — and it is reported by its usage
     * rather than by a status nobody could compute honestly.
     */
    public function isProbed(): bool
    {
        return $this->deployed && $this->checkType() !== 'none';
    }

    public function checkOption(string $name, mixed $default = null): mixed
    {
        return $this->check[$name] ?? $default;
    }

    /**
     * Whether this entry says which machine the service lives on.
     *
     * Declaring the key at all is the statement — "this is not on the default
     * host" — even when the value is empty because the environment has not
     * named the machine yet. Falling back to the default there would report a
     * daemon as missing from a server it was never installed on, which is a
     * false alarm that never stops.
     */
    public function declaresHost(): bool
    {
        return array_key_exists('host', $this->check);
    }
}
