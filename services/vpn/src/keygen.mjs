// Prints a fresh Reality key pair, short id and client secret as .env lines.

import { randomBytes } from "node:crypto";
import { generateReality } from "./identity.mjs";

const { privateKey, publicKey, shortId } = generateReality();

console.log(`VPN_REALITY_PRIVATE_KEY=${privateKey}`);
console.log(`VPN_REALITY_SHORT_ID=${shortId}`);
console.log(`VPN_CLIENT_SECRET=${randomBytes(32).toString("hex")}`);
console.log(`# public key (derived at start, shown for reference): ${publicKey}`);
