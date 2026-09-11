import { expect } from "chai";
import { network } from "hardhat";
import type { RockPaperScissorsAsync } from "../types/ethers-contracts/RockPaperScissorsAsync.js";

const { ethers, networkHelpers } = await network.create();
const stake = ethers.parseEther("1");
const id = 1n;

async function lobby() {
  const [one, two, treasury, outsider] = await ethers.getSigners();
  const arena = (await ethers.deployContract("RockPaperScissorsAsync", [
    treasury.address,
  ])) as unknown as RockPaperScissorsAsync;
  await arena.waitForDeployment();
  await arena.connect(one).createGame({ value: stake });
  return { arena, one, two, treasury, outsider };
}

async function joined() {
  const fixture = await lobby();
  await fixture.arena.connect(fixture.two).joinGame(id, { value: stake });
  return fixture;
}

async function started() {
  const fixture = await joined();
  await fixture.arena.connect(fixture.one).confirmReady(id);
  await fixture.arena.connect(fixture.two).confirmReady(id);
  return fixture;
}

async function seal(
  fixture: Awaited<ReturnType<typeof started>>,
  player: typeof fixture.one,
  move = 1,
) {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  await fixture.arena
    .connect(player)
    .commitMove(
      id,
      await fixture.arena.hashMove(id, player.address, move, secret),
    );
  return secret;
}

async function expire(arena: RockPaperScissorsAsync) {
  await networkHelpers.time.increaseTo((await arena.getGame(id)).deadline + 1n);
}

describe("Asynchronous RPS", function () {
  it("fixes phases at 600 seconds and requires a nonzero treasury", async function () {
    const { arena, treasury } = await networkHelpers.loadFixture(lobby);
    expect(await arena.phaseDuration()).to.equal(600n);
    expect(await arena.rulesVersion()).to.equal(2n);
    expect(await arena.treasury()).to.equal(treasury.address);
    await expect(
      ethers.deployContract("RockPaperScissorsAsync", [ethers.ZeroAddress]),
    ).to.be.revertedWithCustomError(arena, "InvalidTreasury");
  });

  it("keeps a funded challenge open across days, without a deadline or penalty", async function () {
    const { arena, two } = await networkHelpers.loadFixture(lobby);
    await networkHelpers.time.increase(7 * 86400);
    expect((await arena.getGame(id)).deadline).to.equal(0n);
    await expect(arena.cancelExpiredGame(id)).to.be.revertedWithCustomError(
      arena,
      "InvalidPhase",
    );
    await arena.connect(two).joinGame(id, { value: stake });
    expect((await arena.getGame(id)).state).to.equal(6n);
    expect((await arena.getGame(id)).deadline).to.equal(0n);
    expect(await arena.pendingTreasury(id)).to.equal(0n);
  });

  it("lets only the creator cancel an unaccepted challenge and claim exactly once", async function () {
    const { arena, one, two } = await networkHelpers.loadFixture(lobby);
    await expect(
      arena.connect(two).cancelBeforeStart(id),
    ).to.be.revertedWithCustomError(arena, "NotPlayer");
    await arena.connect(one).cancelBeforeStart(id);
    await expect(
      arena.connect(two).joinGame(id, { value: stake }),
    ).to.be.revertedWithCustomError(arena, "InvalidPhase");
    await expect(arena.connect(one).claimPayout(id)).to.changeEtherBalance(
      ethers,
      one,
      stake,
    );
    await expect(
      arena.connect(one).claimPayout(id),
    ).to.be.revertedWithCustomError(arena, "NoPayout");
  });

  for (const who of ["one", "two"] as const) {
    it(`refunds both stakes if ${who} cancels before the start`, async function () {
      const f = await networkHelpers.loadFixture(joined);
      await f.arena.connect(f.one).confirmReady(id);
      await f.arena.connect(f[who]).cancelBeforeStart(id);
      expect(await f.arena.pendingPayout(id, f.one.address)).to.equal(stake);
      expect(await f.arena.pendingPayout(id, f.two.address)).to.equal(stake);
      expect(await f.arena.pendingTreasury(id)).to.equal(0n);
      await expect(
        f.arena.connect(f.two).confirmReady(id),
      ).to.be.revertedWithCustomError(f.arena, "InvalidPhase");
    });
  }

  it("starts only with two recent acknowledgements and gives a full ten minutes", async function () {
    const { arena, one, two, outsider } =
      await networkHelpers.loadFixture(joined);
    await expect(
      arena.connect(outsider).confirmReady(id),
    ).to.be.revertedWithCustomError(arena, "NotPlayer");
    await expect(
      arena.commitMove(id, ethers.id("early")),
    ).to.be.revertedWithCustomError(arena, "InvalidPhase");
    await arena.connect(one).confirmReady(id);
    await networkHelpers.time.increase(86400);
    await arena.connect(two).confirmReady(id);
    expect((await arena.getGame(id)).state).to.equal(6n);
    expect(await arena.pendingTreasury(id)).to.equal(0n);
    const tx = await arena.connect(one).confirmReady(id);
    const block = await ethers.provider.getBlock(
      (await tx.wait())!.blockNumber,
    );
    const game = await arena.getGame(id);
    expect(game.state).to.equal(2n);
    expect(game.deadline).to.equal(BigInt(block!.timestamp) + 600n);
    await expect(
      arena.connect(one).cancelBeforeStart(id),
    ).to.be.revertedWithCustomError(arena, "InvalidPhase");
    await expect(
      arena.connect(one).confirmReady(id),
    ).to.be.revertedWithCustomError(arena, "InvalidPhase");
  });

  it("keeps all nine normal outcomes and gives reveal its own 600 seconds", async function () {
    for (let a = 1; a <= 3; a++) {
      for (let b = 1; b <= 3; b++) {
        const f = await started();
        const secretOne = await seal(f, f.one, a);
        const secretTwo = await seal(f, f.two, b);
        const last = await networkHelpers.time.latest();
        expect((await f.arena.getGame(id)).deadline).to.equal(
          BigInt(last) + 600n,
        );
        await f.arena.connect(f.one).revealMove(id, a, secretOne);
        await f.arena.connect(f.two).revealMove(id, b, secretTwo);
        await f.arena.connect(f.outsider).resolveGame(id);
        const oneWins =
          (a === 1 && b === 3) || (a === 2 && b === 1) || (a === 3 && b === 2);
        expect(await f.arena.pendingPayout(id, f.one.address)).to.equal(
          a === b ? stake : oneWins ? stake * 2n : 0n,
        );
        expect(await f.arena.pendingPayout(id, f.two.address)).to.equal(
          a === b ? stake : oneWins ? 0n : stake * 2n,
        );
        expect(await f.arena.pendingTreasury(id)).to.equal(0n);
        await expect(
          f.arena.cancelBeforeStart(id),
        ).to.be.revertedWithCustomError(f.arena, "InvalidPhase");
      }
    }
  });

  for (const phase of ["commit", "reveal"] as const) {
    for (const active of ["one", "two", "neither"] as const) {
      it(`${phase}: refunds ${active}, accrues inactive stakes to treasury, settles only once`, async function () {
        const f = await networkHelpers.loadFixture(started);
        let secretOne = "";
        let secretTwo = "";
        if (phase === "reveal") {
          secretOne = await seal(f, f.one);
          secretTwo = await seal(f, f.two);
        }
        if (active !== "neither") {
          if (phase === "commit") await seal(f, f[active]);
          else
            await f.arena
              .connect(f[active])
              .revealMove(id, 1, active === "one" ? secretOne : secretTwo);
        }
        await expire(f.arena);
        await f.arena.connect(f.outsider).cancelExpiredGame(id);
        expect((await f.arena.getGame(id)).result).to.equal(4n);
        expect((await f.arena.getGame(id)).winner).to.equal(ethers.ZeroAddress);
        expect(await f.arena.pendingPayout(id, f.one.address)).to.equal(
          active === "one" ? stake : 0n,
        );
        expect(await f.arena.pendingPayout(id, f.two.address)).to.equal(
          active === "two" ? stake : 0n,
        );
        const penalty = active === "neither" ? stake * 2n : stake;
        expect(await f.arena.pendingTreasury(id)).to.equal(penalty);
        await expect(
          f.arena.connect(f.outsider).claimTreasury(id),
        ).to.changeEtherBalance(ethers, f.treasury, penalty);
        if (active !== "neither")
          await expect(
            f.arena.connect(f[active]).claimPayout(id),
          ).to.changeEtherBalance(ethers, f[active], stake);
        expect(await ethers.provider.getBalance(f.arena)).to.equal(0n);
        await expect(
          f.arena.cancelExpiredGame(id),
        ).to.be.revertedWithCustomError(f.arena, "InvalidPhase");
        await expect(f.arena.claimTreasury(id)).to.be.revertedWithCustomError(
          f.arena,
          "NoPayout",
        );
      });
    }
  }

  it("resolves already revealed moves normally even after the deadline", async function () {
    const f = await networkHelpers.loadFixture(started);
    const a = await seal(f, f.one, 1);
    const b = await seal(f, f.two, 3);
    await f.arena.connect(f.one).revealMove(id, 1, a);
    await f.arena.connect(f.two).revealMove(id, 3, b);
    await expire(f.arena);
    await f.arena.cancelExpiredGame(id);
    expect(await f.arena.pendingPayout(id, f.one.address)).to.equal(2n * stake);
    expect(await f.arena.pendingTreasury(id)).to.equal(0n);
  });

  it("accepts a commit at the deadline and refuses late commits", async function () {
    const f = await networkHelpers.loadFixture(started);
    const deadline = (await f.arena.getGame(id)).deadline;
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await seal(f, f.one);
    await expect(
      f.arena.connect(f.two).commitMove(id, ethers.id("late")),
    ).to.be.revertedWithCustomError(f.arena, "DeadlineExpired");
  });

  it("refuses timeout at the deadline but allows it in the following second", async function () {
    const { arena } = await networkHelpers.loadFixture(started);
    const deadline = (await arena.getGame(id)).deadline;
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await expect(
      arena.cancelExpiredGame(id, { gasLimit: 300000 }),
    ).to.be.revertedWithCustomError(arena, "DeadlineNotReached");
    await networkHelpers.time.setNextBlockTimestamp(deadline + 1n);
    await arena.cancelExpiredGame(id, { gasLimit: 300000 });
    expect(await arena.pendingTreasury(id)).to.equal(stake * 2n);
  });

  it("does not let an invalid reveal count as activity", async function () {
    const f = await networkHelpers.loadFixture(started);
    await seal(f, f.one);
    await seal(f, f.two);
    await expect(
      f.arena.connect(f.one).revealMove(id, 1, ethers.id("wrong")),
    ).to.be.revertedWithCustomError(f.arena, "InvalidCommitment");
    await expire(f.arena);
    await f.arena.cancelExpiredGame(id);
    expect(await f.arena.pendingTreasury(id)).to.equal(stake * 2n);
  });
});
