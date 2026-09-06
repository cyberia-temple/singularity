# Rock–Paper–Scissors contract specification

`contracts/RockPaperScissors.sol` is the first Cyberia Arcade reference game.
It is a two-player native-CYBER escrow with no protocol fee.

## Lifecycle

```text
WaitingForPlayer -> Commit -> Reveal -> Resolved
        |              |          |
        +--------------+----------+-> Cancelled (symmetric timeout)
                       +-----------> Resolved (single-player forfeit)
```

The constructor receives one `phaseDuration` in seconds. Every transition starts
a fresh deadline. A player action is accepted through the deadline; timeout
settlement becomes available in the following second.

## Commitments

Clients must call `hashMove` or reproduce this exact encoding:

```solidity
keccak256(abi.encode(address(contract), chainId, gameId, player, move, secret))
```

The contract address, chain, game and player domains prevent a commitment from
being replayed elsewhere. `Move` values are `1 = Rock`, `2 = Paper`, and
`3 = Scissors`; zero is reserved as the unrevealed value. Secrets should be
random 32-byte values and must remain local until reveal.

## Stakes and settlement

- The creator deposits a non-zero native stake.
- The second player must deposit exactly the same amount.
- A winner receives the full two-stake pot.
- A draw credits one stake back to each player.
- If only one player acts before a commit or reveal timeout, that player wins.
- If neither player acts, both stakes are refunded.
- An unjoined expired game refunds its creator.

Settlement only records `pendingPayout`. Each player withdraws their own credit
with `claimPayout(gameId)`. The credit is cleared before the external call, and
the claim function is protected by `ReentrancyGuard`.

## Public API

```text
createGame() payable -> gameId
joinGame(gameId) payable
commitMove(gameId, commitment)
revealMove(gameId, move, secret)
resolveGame(gameId)
cancelExpiredGame(gameId)
claimPayout(gameId)
getGame(gameId)
hashMove(gameId, player, move, secret)
```

`resolveGame` and `cancelExpiredGame` may be called by anyone because their
outcomes are fully determined by committed contract state.

## Wallet discovery contract

The first production client discovers matches without a trusted indexer. It
reads `nextGameId`, takes at most the 50 newest positive ids, and fetches them
newest-first with no more than four concurrent RPC tasks. The window is a
deliberate prototype bound: it makes open and personal matches usable without
turning a browser refresh into an unbounded Cyberia load.

The wallet partitions those canonical contract reads into:

- matches requiring this player's action;
- this player's active matches;
- waiting games this address may join;
- completed personal matches.

An indexer may replace discovery when volume outgrows the bounded window, but
it remains a derived cache. Before presenting an action, the client must still
read the selected game from the contract.

Invitation links contain only a positive `gameId` and open the wallet route:

```text
/wallet?screen=arena&game={gameId}
```

They never contain a move, commitment secret, private key or wallet vault
material. Polling pauses while the document is hidden and refreshes
immediately when it becomes visible again.
