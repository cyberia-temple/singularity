# Releases and Versioning

Cyberia is a monorepo, not a single versioned binary. Keep the wallet, the legacy platform and the chain roadmap separate in release notes.

## Product streams

### Cyberia Wallet — 1.x.x

The **wallet and application builds** use semantic versions (`MAJOR.MINOR.PATCH`) and `app-vX.Y.Z` release tags. This is the active packaging and maturation of wallet features originally developed during the platform's 0.x period; **do not re-label every old 0.x feature as a newly shipped 1.x feature**.

- `MINOR`: visible wallet capability added to an actual build.
- `PATCH`: fixes for a released wallet build.
- An app tag identifies the build; describe separately whether it was distributed as a GitHub artifact, through TestFlight/closed testing, or approved and available in a marketplace.
- The site's feature set and the Android/iOS/desktop/extension editions can differ. Especially do not describe a social-only store-testing edition as supporting transactions.
- Do not create a fake `1.x` version for untagged source changes. Keep these in *Development updates* until a real release is cut.

### Cyberia platform — 0.x legacy

The Laravel/site changelog historically used `v0.x.x`. Keep this historical version sequence and its release notes intact. It is **not** the wallet's version number, and `APP_VERSION` may still represent this legacy site release track.

### Cyberia 2.0 — reserved launch milestone

**Not released.** The Cyberia 2.0 milestone requires **both**:

1. The **second Cyberia chain operational beyond the Fuji testnet**.
2. **Cyberia applications available in their intended marketplaces**, including the applicable mobile and browser-extension stores.

Fuji token tooling, preliminary Avalanche L1 configuration, wallet network entries, store submissions, and closed-test builds alone **do not** satisfy this milestone. Announce 2.0 only after verifying both conditions. This milestone name does not automatically alter wallet `app-v1.x.x` versioning.

### Monorepo source snapshots

Use date-based release tags for source and operations notes:

```text
vYYYY.MM.DD
vYYYY.MM.DD-2    # additional snapshot on the same day
```

Monorepo date tags are independent of wallet `app-vX.Y.Z` tags.

## Release Checklist

1. Confirm the product stream, commit SHA, release tag, and availability channel.
2. Ensure required CI checks pass on the commit.
3. Move verified changes from *Development updates* to that product's release notes; label testnet-only items explicitly.
4. Verify deployed links, contract addresses, ownership and relayer assumptions, and the actual wallet edition's included features.
5. Create and push the appropriate tag:

```bash
# Wallet/app (only when an actual app release is cut)
git tag app-vX.Y.Z && git push origin app-vX.Y.Z

# Monorepo snapshot (only when a source release is cut)
git tag vYYYY.MM.DD && git push origin vYYYY.MM.DD
```

6. Publish a GitHub release and, when relevant, record store review or publication status.

## Good Release Notes

Release notes should say what changed for users, what changed for developers/operators, what is still incomplete or trust-sensitive, and **where it is actually available**. Testnet support is not a mainnet launch; a commit is not a published app-store release.
