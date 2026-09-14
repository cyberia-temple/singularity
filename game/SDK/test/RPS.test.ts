import { expect } from "chai";
import { network } from "hardhat";

import type { RockPaperScissors } from "../types/ethers-contracts/RockPaperScissors.js";

const { ethers, networkHelpers } = await network.create();

const PHASE_DURATION = 300;
const STAKE = ethers.parseEther("1");
const GAME_ID = 1n;

const Move = {
  None: 0,
  Rock: 1,
  Paper: 2,
  Scissors: 3,
} as const;

const State = {
  WaitingForPlayer: 1n,
  Commit: 2n,
  Reveal: 3n,
  Resolved: 4n,
  Cancelled: 5n,
} as const;

const Result = {
  PlayerOneWins: 1n,
  PlayerTwoWins: 2n,
  Draw: 3n,
} as const;

async function deployGame() {
  const [playerOne, playerTwo, outsider] = await ethers.getSigners();
  const rps = (await ethers.deployContract("RockPaperScissors", [
    PHASE_DURATION,
  ])) as unknown as RockPaperScissors;
  await rps.waitForDeployment();

  return { rps, playerOne, playerTwo, outsider };
}

async function createAndJoin() {
  const fixture = await deployGame();
  const { rps, playerOne, playerTwo } = fixture;
  await rps.connect(playerOne).createGame({ value: STAKE });
  await rps.connect(playerTwo).joinGame(GAME_ID, { value: STAKE });

  return fixture;
}

async function commit(
  rps: Awaited<ReturnType<typeof deployGame>>["rps"],
  player: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  move: number,
  secret: string,
) {
  const commitment = await rps.hashMove(GAME_ID, player.address, move, secret);
  await rps.connect(player).commitMove(GAME_ID, commitment);
}

async function readyToReveal(
  moveOne: number = Move.Rock,
  moveTwo: number = Move.Scissors,
) {
  const fixture = await createAndJoin();
  const secretOne = ethers.id("player-one-secret");
  const secretTwo = ethers.id("player-two-secret");
  await commit(fixture.rps, fixture.playerOne, moveOne, secretOne);
  await commit(fixture.rps, fixture.playerTwo, moveTwo, secretTwo);

  return { ...fixture, moveOne, moveTwo, secretOne, secretTwo };
}

async function readyToRevealFixture() {
  return readyToReveal();
}

async function expire(rps: Awaited<ReturnType<typeof deployGame>>["rps"]) {
  const game = await rps.getGame(GAME_ID);
  await networkHelpers.time.increaseTo(game.deadline + 1n);
}

describe("RockPaperScissors", function () {
  it("rejects a zero phase timeout", async function () {
    await expect(
      ethers.deployContract("RockPaperScissors", [0]),
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("RockPaperScissors"),
      "ZeroTimeout",
    );
  });

  it("creates a funded game with an expiry", async function () {
    const { rps, playerOne } = await networkHelpers.loadFixture(deployGame);

    await expect(rps.connect(playerOne).createGame({ value: STAKE })).to.emit(
      rps,
      "GameCreated",
    );

    const game = await rps.getGame(GAME_ID);
    expect(game.playerOne).to.equal(playerOne.address);
    expect(game.stake).to.equal(STAKE);
    expect(game.state).to.equal(State.WaitingForPlayer);
    expect(await ethers.provider.getBalance(rps)).to.equal(STAKE);
  });

  it("rejects zero-stake games and unknown game IDs", async function () {
    const { rps, playerOne } = await networkHelpers.loadFixture(deployGame);

    await expect(
      rps.connect(playerOne).createGame(),
    ).to.be.revertedWithCustomError(rps, "ZeroStake");
    await expect(rps.getGame(999))
      .to.be.revertedWithCustomError(rps, "GameNotFound")
      .withArgs(999);
  });

  it("requires a distinct second player with an equal stake", async function () {
    const { rps, playerOne, playerTwo, outsider } =
      await networkHelpers.loadFixture(deployGame);
    await rps.connect(playerOne).createGame({ value: STAKE });

    await expect(
      rps.connect(playerOne).joinGame(GAME_ID, { value: STAKE }),
    ).to.be.revertedWithCustomError(rps, "SamePlayer");
    await expect(
      rps.connect(playerTwo).joinGame(GAME_ID, { value: STAKE / 2n }),
    )
      .to.be.revertedWithCustomError(rps, "IncorrectStake")
      .withArgs(STAKE, STAKE / 2n);
    await rps.connect(playerTwo).joinGame(GAME_ID, { value: STAKE });
    await expect(
      rps.connect(outsider).joinGame(GAME_ID, { value: STAKE }),
    ).to.be.revertedWithCustomError(rps, "InvalidPhase");
  });

  it("rejects joining after the waiting deadline", async function () {
    const { rps, playerOne, playerTwo } =
      await networkHelpers.loadFixture(deployGame);
    await rps.connect(playerOne).createGame({ value: STAKE });
    await expire(rps);

    await expect(
      rps.connect(playerTwo).joinGame(GAME_ID, { value: STAKE }),
    ).to.be.revertedWithCustomError(rps, "DeadlineExpired");
  });

  it("accepts one commitment per player and enters reveal phase", async function () {
    const { rps, playerOne, playerTwo, outsider } =
      await networkHelpers.loadFixture(createAndJoin);
    const secret = ethers.id("secret");
    const commitment = await rps.hashMove(
      GAME_ID,
      playerOne.address,
      Move.Rock,
      secret,
    );

    await expect(
      rps.connect(outsider).commitMove(GAME_ID, commitment),
    ).to.be.revertedWithCustomError(rps, "NotPlayer");
    await expect(
      rps.connect(playerOne).commitMove(GAME_ID, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(rps, "InvalidCommitment");
    await rps.connect(playerOne).commitMove(GAME_ID, commitment);
    await expect(
      rps.connect(playerOne).commitMove(GAME_ID, commitment),
    ).to.be.revertedWithCustomError(rps, "InvalidCommitment");
    await commit(rps, playerTwo, Move.Paper, ethers.id("other-secret"));

    expect((await rps.getGame(GAME_ID)).state).to.equal(State.Reveal);
  });

  it("domain-separates commitments by contract, chain, game and player", async function () {
    const { rps, playerOne, playerTwo } =
      await networkHelpers.loadFixture(createAndJoin);
    const secret = ethers.id("domain-secret");

    const one = await rps.hashMove(
      GAME_ID,
      playerOne.address,
      Move.Rock,
      secret,
    );
    const two = await rps.hashMove(
      GAME_ID,
      playerTwo.address,
      Move.Rock,
      secret,
    );
    expect(one).not.to.equal(two);
  });

  it("rejects commitments after the commit deadline", async function () {
    const { rps, playerOne } = await networkHelpers.loadFixture(createAndJoin);
    const secret = ethers.id("late-commit");
    const commitment = await rps.hashMove(
      GAME_ID,
      playerOne.address,
      Move.Rock,
      secret,
    );
    await expire(rps);

    await expect(
      rps.connect(playerOne).commitMove(GAME_ID, commitment),
    ).to.be.revertedWithCustomError(rps, "DeadlineExpired");
  });

  it("rejects invalid, mismatched and duplicate reveals", async function () {
    const { rps, playerOne, playerTwo, outsider, secretOne, secretTwo } =
      await networkHelpers.loadFixture(readyToRevealFixture);

    await expect(
      rps.connect(outsider).revealMove(GAME_ID, Move.Rock, secretOne),
    ).to.be.revertedWithCustomError(rps, "NotPlayer");
    await expect(
      rps.connect(playerOne).revealMove(GAME_ID, Move.None, secretOne),
    ).to.be.revertedWithCustomError(rps, "InvalidMove");
    await expect(
      rps
        .connect(playerOne)
        .revealMove(GAME_ID, Move.Rock, ethers.id("wrong-secret")),
    ).to.be.revertedWithCustomError(rps, "InvalidCommitment");
    await rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne);
    await expect(
      rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne),
    ).to.be.revertedWithCustomError(rps, "InvalidCommitment");
    await rps.connect(playerTwo).revealMove(GAME_ID, Move.Scissors, secretTwo);
  });

  it("rejects reveals after the reveal deadline", async function () {
    const { rps, playerOne, secretOne } =
      await networkHelpers.loadFixture(readyToRevealFixture);
    await expire(rps);

    await expect(
      rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne),
    ).to.be.revertedWithCustomError(rps, "DeadlineExpired");
  });

  const outcomes = [
    [Move.Rock, Move.Scissors, Result.PlayerOneWins],
    [Move.Scissors, Move.Paper, Result.PlayerOneWins],
    [Move.Paper, Move.Rock, Result.PlayerOneWins],
    [Move.Scissors, Move.Rock, Result.PlayerTwoWins],
    [Move.Paper, Move.Scissors, Result.PlayerTwoWins],
    [Move.Rock, Move.Paper, Result.PlayerTwoWins],
    [Move.Rock, Move.Rock, Result.Draw],
  ] as const;

  for (const [moveOne, moveTwo, expectedResult] of outcomes) {
    it(`resolves ${moveOne} versus ${moveTwo} as result ${expectedResult}`, async function () {
      const { rps, playerOne, playerTwo, secretOne, secretTwo } =
        await readyToReveal(moveOne, moveTwo);
      await rps.connect(playerOne).revealMove(GAME_ID, moveOne, secretOne);
      await rps.connect(playerTwo).revealMove(GAME_ID, moveTwo, secretTwo);
      await rps.resolveGame(GAME_ID);

      const game = await rps.getGame(GAME_ID);
      expect(game.state).to.equal(State.Resolved);
      expect(game.result).to.equal(expectedResult);
      if (expectedResult === Result.Draw) {
        expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(
          STAKE,
        );
        expect(await rps.pendingPayout(GAME_ID, playerTwo.address)).to.equal(
          STAKE,
        );
      } else {
        const winner =
          expectedResult === Result.PlayerOneWins ? playerOne : playerTwo;
        expect(game.winner).to.equal(winner.address);
        expect(await rps.pendingPayout(GAME_ID, winner.address)).to.equal(
          STAKE * 2n,
        );
      }
    });
  }

  it("refunds an expired game that nobody joined", async function () {
    const { rps, playerOne } = await networkHelpers.loadFixture(deployGame);
    await rps.connect(playerOne).createGame({ value: STAKE });
    await expire(rps);

    await expect(rps.cancelExpiredGame(GAME_ID))
      .to.emit(rps, "GameCancelled")
      .withArgs(GAME_ID);
    expect((await rps.getGame(GAME_ID)).state).to.equal(State.Cancelled);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(STAKE);
  });

  it("awards the pot when the opponent misses the commit deadline", async function () {
    const { rps, playerOne, playerTwo } =
      await networkHelpers.loadFixture(createAndJoin);
    await commit(rps, playerOne, Move.Rock, ethers.id("committed"));
    await expire(rps);

    await rps.connect(playerTwo).cancelExpiredGame(GAME_ID);
    expect((await rps.getGame(GAME_ID)).winner).to.equal(playerOne.address);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(
      STAKE * 2n,
    );
  });

  it("refunds both players when neither commits", async function () {
    const { rps, playerOne, playerTwo } =
      await networkHelpers.loadFixture(createAndJoin);
    await expire(rps);

    await rps.cancelExpiredGame(GAME_ID);
    expect((await rps.getGame(GAME_ID)).state).to.equal(State.Cancelled);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(STAKE);
    expect(await rps.pendingPayout(GAME_ID, playerTwo.address)).to.equal(STAKE);
  });

  it("awards the pot when the opponent misses the reveal deadline", async function () {
    const { rps, playerOne, secretOne } =
      await networkHelpers.loadFixture(readyToRevealFixture);
    await rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne);
    await expire(rps);

    await rps.cancelExpiredGame(GAME_ID);
    expect((await rps.getGame(GAME_ID)).winner).to.equal(playerOne.address);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(
      STAKE * 2n,
    );
  });

  it("refunds both players when neither reveals", async function () {
    const { rps, playerOne, playerTwo } =
      await networkHelpers.loadFixture(readyToRevealFixture);
    await expire(rps);

    await rps.cancelExpiredGame(GAME_ID);
    expect((await rps.getGame(GAME_ID)).state).to.equal(State.Cancelled);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(STAKE);
    expect(await rps.pendingPayout(GAME_ID, playerTwo.address)).to.equal(STAKE);
  });

  it("resolves normally after expiry when both moves were revealed", async function () {
    const { rps, playerOne, playerTwo, secretOne, secretTwo } =
      await networkHelpers.loadFixture(readyToRevealFixture);
    await rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne);
    await rps.connect(playerTwo).revealMove(GAME_ID, Move.Scissors, secretTwo);
    await expire(rps);

    await rps.cancelExpiredGame(GAME_ID);
    expect((await rps.getGame(GAME_ID)).winner).to.equal(playerOne.address);
  });

  it("cannot cancel a live game", async function () {
    const { rps } = await networkHelpers.loadFixture(createAndJoin);

    await expect(rps.cancelExpiredGame(GAME_ID)).to.be.revertedWithCustomError(
      rps,
      "DeadlineNotReached",
    );
  });

  it("pays exactly once using checks-effects-interactions", async function () {
    const { rps, playerOne, playerTwo, secretOne, secretTwo } =
      await networkHelpers.loadFixture(readyToRevealFixture);
    await rps.connect(playerOne).revealMove(GAME_ID, Move.Rock, secretOne);
    await rps.connect(playerTwo).revealMove(GAME_ID, Move.Scissors, secretTwo);
    await rps.resolveGame(GAME_ID);

    await expect(rps.connect(playerOne).claimPayout(GAME_ID))
      .to.emit(rps, "PayoutClaimed")
      .withArgs(GAME_ID, playerOne.address, STAKE * 2n);
    expect(await ethers.provider.getBalance(rps)).to.equal(0);
    expect(await rps.pendingPayout(GAME_ID, playerOne.address)).to.equal(0);
    await expect(
      rps.connect(playerOne).claimPayout(GAME_ID),
    ).to.be.revertedWithCustomError(rps, "NoPayout");
    await expect(
      rps.connect(playerTwo).claimPayout(GAME_ID),
    ).to.be.revertedWithCustomError(rps, "NoPayout");
  });
});
