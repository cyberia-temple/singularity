# Contract security notes

## Implemented controls

- Domain-separated commit hashes hide moves until reveal and resist replay.
- Explicit phases reject invalid state transitions and duplicate actions.
- Every interactive phase has a deadline, so one player cannot lock the pot.
- Equal stakes are enforced on chain.
- Settlement changes state before creating withdrawal credits.
- Pull payments isolate payout failures and use `ReentrancyGuard`.
- A payout credit is zeroed before transferring native CYBER.
- Unknown games, non-players, zero commitments and invalid moves fail closed.

## Assumptions

- `block.timestamp` is sufficiently accurate for game-scale deadlines; users
  should not configure deadlines close to one block interval.
- Client secrets are cryptographically random and remain private until reveal.
- The Cyberia chain preserves normal EVM transaction and timestamp semantics.
- There is no protocol fee, treasury, upgradeability or privileged owner in
  this phase.

## Remaining production gates

Phase 2 tests deterministic behavior but is not an independent audit. Before a
value-bearing public release, add invariant and fuzz tests, test adversarial
receiver contracts, measure realistic Cyberia block timing, and obtain an
independent review of state-machine and payout correctness.
