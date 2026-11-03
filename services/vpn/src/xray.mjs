// The tunnel itself: one Xray process, rewritten and restarted whenever the
// set of paying addresses changes.
//
// A restart drops open connections for about a second. It happens only when
// somebody buys a first pass or one runs out, which is rare next to the cost
// of a second moving part (Xray's gRPC user API) that would have to agree with
// the config file anyway.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

/**
 * Xray's config for `clients` (a list of `{ id, email }`). Pure.
 *
 * Outbound traffic to private and loopback ranges is dropped: a VPN client
 * must not reach this host's own RPC, Docker bridge or LAN. Port 25 is dropped
 * because a VPN that lets anyone send mail is a VPN on every blocklist.
 */
export function buildConfig({ port, dest, serverName, privateKey, shortId, clients }) {
  // An inbound with no clients is legal, but a placeholder nobody holds keeps
  // the shape of the config the same whether or not anyone has paid yet.
  const list = clients.length > 0 ? clients : [{ id: randomUUID(), email: "nobody" }];

  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "vless-reality",
        listen: "0.0.0.0",
        port,
        protocol: "vless",
        settings: {
          clients: list.map(({ id, email }) => ({ id, email, flow: "xtls-rprx-vision" })),
          decryption: "none",
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            show: false,
            dest,
            xver: 0,
            serverNames: [serverName],
            privateKey,
            shortIds: [shortId],
          },
        },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: true },
      },
    ],
    outbounds: [
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" },
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        { type: "field", ip: ["geoip:private"], outboundTag: "block" },
        { type: "field", port: "25", outboundTag: "block" },
      ],
    },
  };
}

/** Keeps one Xray child alive on `configPath`; `apply()` rewrites and restarts it. */
export class XrayProcess {
  constructor({ binary, configPath, log = console }) {
    this.binary = binary;
    this.configPath = configPath;
    this.log = log;
    this.child = null;
    this.stopping = false;
  }

  apply(config) {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.restart();
  }

  restart() {
    const previous = this.child;
    this.child = null;
    if (previous) {
      previous.removeAllListeners("exit");
      previous.kill("SIGTERM");
    }
    this.start();
  }

  start() {
    const child = spawn(this.binary, ["run", "-c", this.configPath], { stdio: "inherit" });
    this.child = child;
    child.on("exit", (code, signal) => {
      if (this.stopping || this.child !== child) {
        return;
      }
      this.log.error(`xray exited (${code ?? signal}); restarting in 3s`);
      this.child = null;
      setTimeout(() => this.child ?? this.start(), 3000);
    });
  }

  stop() {
    this.stopping = true;
    this.child?.kill("SIGTERM");
  }
}
