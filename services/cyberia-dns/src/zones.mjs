// Which zones this server answers for.
//
// The list is the contract's: `cyber`, plus one zone per launchpad token named
// `.<zone>` with the ticker `DOT<ZONE>`. Anybody can launch such a token, which
// is the point and also the danger — a token named `.com` would otherwise make
// this server answer authoritatively for every .com name its DoH users look
// up. So a chain zone is served only when it is *not* a name the real root
// already delegates: each one is asked of an upstream resolver (`NS <zone>.`)
// and anything but NXDOMAIN keeps it off. That check fails closed — a zone
// whose answer could not be read is not served until it can be — and the
// names that are special without being in the root (RFC 6761/6762, `.onion`,
// the private-use ones) are never served at all.
//
// Aliases put the same names under a delegated suffix of a real domain:
// `lain.cyber.cyberia.church` is `lain.cyber`, for resolvers that do not
// know this server exists.

export const RESERVED = new Set([
  'localhost', 'local', 'arpa', 'onion', 'test', 'example', 'invalid', 'internal',
  'home', 'lan', 'corp', 'intranet', 'private', 'alt', 'localdomain', 'home-arpa',
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function createZoneBook({
  readZones,
  isDelegated,
  aliases = {},
  trusted = ['cyber'],
  checkMs = 6 * 3600_000,
  now = Date.now,
  log = () => {},
}) {
  /** zone → { token } for every zone currently served. */
  let served = new Map();
  /** zone → { at, delegated } — the root's answer, remembered. */
  const checks = new Map();
  let loadedAt = 0;

  async function delegated(zone) {
    if (trusted.includes(zone)) return false;
    const hit = checks.get(zone);
    if (hit && now() - hit.at < checkMs) return hit.delegated;
    try {
      const answer = await isDelegated(zone);
      checks.set(zone, { at: now(), delegated: answer });
      if (answer) log(`zone .${zone} exists in the DNS root; not serving it`);
      return answer;
    } catch (e) {
      // Unknown is not "free": keep the last real answer, or stay off.
      log(`zone .${zone}: root check failed (${e.message}); ${hit ? 'keeping last answer' : 'not serving yet'}`);
      return hit ? hit.delegated : true;
    }
  }

  async function refresh() {
    const list = await readZones();
    const next = new Map();
    for (const { zone, token, blocked } of list) {
      if (blocked || !LABEL.test(zone) || RESERVED.has(zone)) continue;
      if (await delegated(zone)) continue;
      next.set(zone, { token });
    }
    served = next;
    loadedAt = now();
    return [...served.keys()];
  }

  /**
   * The zone a name falls in: `suffix` is what the name ends with here
   * (`moon`, or an alias like `cyber.cyberia.church`), `zone` is the chain's.
   */
  function match(qname) {
    let best = null;
    const consider = (suffix, zone) => {
      if ((qname === suffix || qname.endsWith(`.${suffix}`)) && (!best || suffix.length > best.suffix.length)) {
        best = { suffix, zone };
      }
    };
    for (const zone of served.keys()) consider(zone, zone);
    for (const [suffix, zone] of Object.entries(aliases)) if (served.has(zone)) consider(suffix, zone);
    return best;
  }

  const list = () => [...served.entries()].map(([zone, { token }]) => ({ zone, token }));

  return { refresh, match, list, loadedAt: () => loadedAt };
}

/** A zone book with a fixed list, for tests and for running without a chain. */
export function staticZoneBook(zones, aliases = {}) {
  const book = createZoneBook({
    readZones: async () => zones.map((zone) => ({ zone, token: null, blocked: false })),
    isDelegated: async () => false,
    aliases,
  });
  return book;
}
