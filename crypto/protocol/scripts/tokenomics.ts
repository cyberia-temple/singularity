/**
 * Fire and Ash, week by week: what the Minter's rules make of a given level of activity.
 *
 *   node scripts/tokenomics.ts [config.json]
 *
 * Uses the same arithmetic as contracts/incentives/Minter.sol, with the numbers from the deploy
 * config, over four steady scenarios of how much CYBER the chain burns and locks each week. The
 * point is to see the shape -- how much ASH exists when, and where it came from -- not to forecast.
 */

import * as fs from "node:fs";

const configPath = process.argv[2] ?? "deploy.config.example.json";
const { ash } = JSON.parse(fs.readFileSync(configPath, "utf8"));

const CAP = Number(ash.cap);
const DROP = Number(ash.pioneerDrop);
const RATE = Number(ash.rate);
const CEILING = Number(ash.ceilingBps) / 10_000;
const DECAY = Number(ash.kindlingDecayBps) / 10_000;
const KINDLING = Number(ash.kindling);
const CYBER_SUPPLY = 1_000_000;

type Scenario = { name: string; gas: number; launches: number; lockedPerLaunch: number; furnace: number };

/** CYBER per week: gas burned, launches × CYBER each locks, protocol revenue burned by the furnace. */
const scenarios: Scenario[] = [
  { name: "cold (today)", gas: 0.2, launches: 0.25, lockedPerLaunch: 10, furnace: 0.1 },
  { name: "village", gas: 5, launches: 2, lockedPerLaunch: 25, furnace: 5 },
  { name: "town", gas: 50, launches: 10, lockedPerLaunch: 50, furnace: 100 },
  { name: "city", gas: 500, launches: 50, lockedPerLaunch: 100, furnace: 2_000 },
];

const checkpoints = [13, 52, 104, 260];

function run(s: Scenario) {
  let supply = DROP;
  let kindling = KINDLING;
  let fromFire = 0;
  let fromKindling = 0;
  let heatTotal = 0;
  const rows: Record<number, string[]> = {};
  const heat = s.gas + s.launches * s.lockedPerLaunch + s.furnace;

  for (let week = 1; week <= 260; week++) {
    // The fire cannot burn CYBER that no longer exists.
    const weekHeat = Math.min(heat, CYBER_SUPPLY - heatTotal);
    const fire = weekHeat * RATE;
    const ceiling = (CAP - supply) * CEILING;
    let minted = fire + kindling;
    let fireMinted = fire;
    if (minted > ceiling) {
      minted = ceiling;
      fireMinted = Math.min(fire, ceiling);
    }
    fromFire += fireMinted;
    fromKindling += minted - fireMinted;
    supply += minted;
    heatTotal += weekHeat;
    kindling *= DECAY;

    if (checkpoints.includes(week)) {
      rows[week] = [
        `${(supply / 1e6).toFixed(2)}M ASH`,
        `${((fromFire / supply) * 100).toFixed(0)}% from fire`,
        `${heatTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} CYBER burned/locked (${((heatTotal / CYBER_SUPPLY) * 100).toFixed(2)}%)`,
        `${((heatTotal * 1000) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M CYBER.sol mirror-burned`,
      ];
    }
  }
  return { heat, rows, fromKindling };
}

console.log(`ASH cap ${CAP / 1e6}M · pioneer drop ${DROP / 1e6}M · ${RATE} ASH per CYBER of fire`);
console.log(`ceiling ${CEILING * 100}% of what is left per week · kindling ${KINDLING / 1e3}k/week, ×${DECAY} weekly\n`);
for (const s of scenarios) {
  const { heat, rows, fromKindling } = run(s);
  console.log(`${s.name}: ${heat.toLocaleString("en-US")} CYBER of fire a week`);
  for (const week of checkpoints) {
    console.log(`  week ${String(week).padStart(3)}  ${rows[week].join(" · ")}`);
  }
  console.log(`  kindling minted in all: ${(fromKindling / 1e6).toFixed(2)}M ASH\n`);
}
