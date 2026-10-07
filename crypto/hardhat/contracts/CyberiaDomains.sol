// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ILaunchpadPairs {
    function pairOf(address token) external view returns (address);
}

interface ILaunchpadPools {
    function poolOf(address token) external view returns (address);
}

/// @title CyberiaDomains — domain names as NFTs, in zones that tokens open.
/// @notice Successor of CyberiaNames. Two things changed: a domain is now an
///         ERC-721 (it can be held, sent, sold and shown like any other NFT),
///         and `.cyber` is no longer the only zone.
///
///         **A zone is a launchpad token.** Launch a token named `.moon` with
///         the ticker `DOTMOON` on a Cyberia launchpad and `createZone(token)`
///         opens the zone `moon` — anyone may call it, because everything it
///         checks is already on chain: the launchpad listed the token, and the
///         name and ticker say which zone it is. Nothing is decided by a
///         person, so there is nothing for one to front-run.
///
///         **A domain in a token's zone is paid for in that token, and the
///         payment is burned.** The launchpads keep no record of who launched
///         what, so a zone cannot have an owner this contract could prove;
///         what it has instead is a token, and registering a name burns
///         `totalSupply / feeDivisor` of it. The root zone `cyber` has no
///         token and costs `cyberPrice` in native CYBER, held here until the
///         owner withdraws it.
///
///         Records are the same `key → string` bag as CyberiaNames, read by
///         `services/cyberia-dns` (A, AAAA, CNAME, TXT, MX, ipfs, url, addr,
///         `<sub>/<TYPE>`, `*/<TYPE>`); whoever holds the NFT writes them.
contract CyberiaDomains is ERC721, Ownable {
    using Strings for uint256;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    string public constant ROOT_ZONE = "cyber";
    uint256 public constant MAX_KEY = 64;
    uint256 public constant MAX_VALUE = 1024;

    /// @notice How a launchpad says it listed a token.
    uint8 public constant LISTS_BY_PAIR = 1; // LaunchpadNative / Launchpad: pairOf(token)
    uint8 public constant LISTS_BY_POOL = 2; // LaunchpadV3: poolOf(token)

    struct Zone {
        address token; // zero for the root zone
        uint64 createdAt;
        bool exists;
        bool blocked;
    }

    struct Domain {
        string label;
        string zone;
        uint64 registeredAt;
    }

    /// @notice Root-zone price in wei of native CYBER.
    uint256 public cyberPrice;

    /// @notice A token zone's fee is `totalSupply / feeDivisor` of its token.
    uint256 public feeDivisor = 1_000_000;

    mapping(address => uint8) public launchpadKind;
    address[] public launchpads;

    mapping(bytes32 => Zone) private _zones;
    string[] private _zoneLabels;
    mapping(address => string) public zoneOfToken;

    mapping(uint256 => Domain) private _domains;
    mapping(uint256 => mapping(bytes32 => string)) private _records;
    mapping(uint256 => string[]) private _recordKeys;
    mapping(uint256 => mapping(bytes32 => uint256)) private _recordSlot; // index + 1

    event ZoneCreated(string zone, address indexed token);
    event ZoneBlocked(string zone, bool blocked);
    event DomainRegistered(uint256 indexed tokenId, string label, string zone, address indexed owner, uint256 paid);
    event RecordSet(uint256 indexed tokenId, string key, string value);
    event LaunchpadSet(address indexed launchpad, uint8 kind);

    constructor(uint256 cyberPrice_) ERC721("Cyberia Domains", "DOMAIN") {
        cyberPrice = cyberPrice_;
        _zones[keccak256(bytes(ROOT_ZONE))] = Zone(address(0), uint64(block.timestamp), true, false);
        _zoneLabels.push(ROOT_ZONE);
        emit ZoneCreated(ROOT_ZONE, address(0));
    }

    // ── zones ────────────────────────────────────────────────────────────

    /// @notice Open the zone a launchpad token names. Permissionless.
    function createZone(address token) external returns (string memory label) {
        require(bytes(zoneOfToken[token]).length == 0, "zone exists");
        require(launched(token), "not a launchpad token");

        label = zoneFromToken(IERC20Metadata(token).name(), IERC20Metadata(token).symbol());
        require(bytes(label).length != 0, "not a zone token");

        bytes32 zh = keccak256(bytes(label));
        require(!_zones[zh].exists, "zone taken");

        _zones[zh] = Zone(token, uint64(block.timestamp), true, false);
        _zoneLabels.push(label);
        zoneOfToken[token] = label;
        emit ZoneCreated(label, token);
    }

    /// @notice Whether some registered launchpad listed this token.
    function launched(address token) public view returns (bool) {
        for (uint256 i = 0; i < launchpads.length; i++) {
            address pad = launchpads[i];
            uint8 kind = launchpadKind[pad];
            if (kind == LISTS_BY_PAIR) {
                try ILaunchpadPairs(pad).pairOf(token) returns (address pair) {
                    if (pair != address(0)) return true;
                } catch {}
            } else if (kind == LISTS_BY_POOL) {
                try ILaunchpadPools(pad).poolOf(token) returns (address pool) {
                    if (pool != address(0)) return true;
                } catch {}
            }
        }
        return false;
    }

    /// @notice The zone a name/ticker pair spells, or "" when it spells none:
    ///         `.moon` + `DOTMOON` → `moon`. Case is folded on both, so `.Moon`
    ///         / `DotMoon` open the same zone; the result is a DNS label.
    function zoneFromToken(string memory name_, string memory symbol_) public pure returns (string memory) {
        bytes memory n = bytes(name_);
        bytes memory s = bytes(symbol_);
        if (n.length < 2 || n[0] != 0x2E || s.length != n.length + 2) return "";

        bytes memory z = new bytes(n.length - 1);
        for (uint256 i = 1; i < n.length; i++) z[i - 1] = _lower(n[i]);
        if (!_validLabel(z)) return "";

        if (_lower(s[0]) != "d" || _lower(s[1]) != "o" || _lower(s[2]) != "t") return "";
        for (uint256 i = 0; i < z.length; i++) {
            if (_lower(s[i + 3]) != z[i]) return "";
        }

        return string(z);
    }

    function zone(string calldata zone_)
        external
        view
        returns (bool exists, address token, bool blocked, uint256 fee, uint64 createdAt)
    {
        Zone memory z = _zones[keccak256(bytes(zone_))];
        return (z.exists, z.token, z.blocked, z.exists ? _fee(z) : 0, z.createdAt);
    }

    /// @notice Every zone, for the DNS server and the wallet's zone list.
    function zones() external view returns (string[] memory labels, address[] memory tokens, bool[] memory blocked) {
        uint256 n = _zoneLabels.length;
        labels = new string[](n);
        tokens = new address[](n);
        blocked = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            Zone memory z = _zones[keccak256(bytes(_zoneLabels[i]))];
            labels[i] = _zoneLabels[i];
            tokens[i] = z.token;
            blocked[i] = z.blocked;
        }
    }

    // ── domains ──────────────────────────────────────────────────────────

    function tokenIdOf(string memory label, string memory zone_) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(label, ".", zone_)));
    }

    /// @notice Register `label.zone` to the caller. The root zone takes
    ///         exactly `cyberPrice` in CYBER; a token zone takes no CYBER and
    ///         burns its fee in the zone's token (approve it first).
    function register(string calldata label, string calldata zone_) external payable returns (uint256 tokenId) {
        Zone memory z = _openZone(zone_);
        uint256 fee = _fee(z);

        if (z.token == address(0)) {
            require(msg.value == fee, "wrong price");
        } else {
            require(msg.value == 0, "pay in the zone token");
            if (fee > 0) require(IERC20(z.token).transferFrom(msg.sender, BURN, fee), "fee transfer failed");
        }

        tokenId = _register(label, zone_, msg.sender, z.token == address(0) ? msg.value : fee);
    }

    /// @notice Free root-zone registration: reserving the project's names or
    ///         onboarding somebody who holds no gas. Token zones are not the
    ///         owner's to hand out.
    function registerFor(string calldata label, address to) external onlyOwner returns (uint256) {
        require(to != address(0), "zero owner");
        _openZone(ROOT_ZONE);
        return _register(label, ROOT_ZONE, to, 0);
    }

    function available(string calldata label, string calldata zone_) external view returns (bool) {
        Zone memory z = _zones[keccak256(bytes(zone_))];
        return z.exists && !z.blocked && _validLabel(bytes(label)) && _ownerOf(tokenIdOf(label, zone_)) == address(0);
    }

    function domain(uint256 tokenId) external view returns (string memory label, string memory zone_, uint64 registeredAt) {
        Domain memory d = _domains[tokenId];
        return (d.label, d.zone, d.registeredAt);
    }

    // ── records ──────────────────────────────────────────────────────────

    /// @notice Write records; an empty value deletes one.
    function setRecords(string calldata label, string calldata zone_, string[] calldata keys, string[] calldata values)
        external
    {
        require(keys.length == values.length, "length mismatch");
        uint256 id = tokenIdOf(label, zone_);
        require(_isApprovedOrOwner(msg.sender, id), "not domain owner");

        for (uint256 i = 0; i < keys.length; i++) _setRecord(id, keys[i], values[i]);
    }

    /// @notice One name's owner (zero = unregistered, or its zone is
    ///         blocked) and the asked-for records, "" where unset.
    function resolve(string calldata label, string calldata zone_, string[] calldata keys)
        external
        view
        returns (address owner, string[] memory values)
    {
        uint256 id = tokenIdOf(label, zone_);
        Zone memory z = _zones[keccak256(bytes(zone_))];
        owner = z.exists && !z.blocked ? _ownerOf(id) : address(0);
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) values[i] = _records[id][keccak256(bytes(keys[i]))];
    }

    function records(string calldata label, string calldata zone_)
        external
        view
        returns (string[] memory keys, string[] memory values)
    {
        uint256 id = tokenIdOf(label, zone_);
        keys = _recordKeys[id];
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) values[i] = _records[id][keccak256(bytes(keys[i]))];
    }

    // ── metadata ─────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireMinted(tokenId);
        Domain memory d = _domains[tokenId];
        // Labels are [a-z0-9-], so the name needs no escaping in JSON or SVG.
        string memory full = string(abi.encodePacked(d.label, ".", d.zone));
        uint256 len = bytes(full).length;
        string memory size = len <= 12 ? "40" : len <= 20 ? "28" : len <= 32 ? "18" : "11";

        bytes memory svg = abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>",
            "<rect width='400' height='400' fill='#0b0b10'/>",
            "<rect x='16' y='16' width='368' height='368' fill='none' stroke='#2a2a3a'/>",
            "<text x='32' y='58' fill='#c08cff' font-family='monospace' font-size='14' letter-spacing='3'>CYBERIA DOMAIN</text>",
            "<text x='32' y='212' fill='#e8e8f0' font-family='monospace' font-size='",
            size,
            "'>",
            full,
            "</text><text x='32' y='360' fill='#7a7a90' font-family='monospace' font-size='13'>.",
            d.zone,
            " zone</text></svg>"
        );

        bytes memory json = abi.encodePacked(
            '{"name":"',
            full,
            '","description":"A Cyberia domain. Whoever holds this token controls the DNS records of ',
            full,
            '.","image":"data:image/svg+xml;base64,',
            Base64.encode(svg),
            '","attributes":[{"trait_type":"zone","value":"',
            d.zone,
            '"},{"trait_type":"length","value":',
            bytes(d.label).length.toString(),
            "}]}"
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    // ── admin ────────────────────────────────────────────────────────────

    function setLaunchpad(address launchpad, uint8 kind) external onlyOwner {
        require(kind <= LISTS_BY_POOL, "bad kind");
        if (launchpadKind[launchpad] == 0 && kind != 0) launchpads.push(launchpad);
        launchpadKind[launchpad] = kind;
        emit LaunchpadSet(launchpad, kind);
    }

    /// @notice For abuse only: a blocked zone resolves nothing and sells
    ///         nothing. The NFTs stay where they are.
    function blockZone(string calldata zone_, bool blocked_) external onlyOwner {
        Zone storage z = _zones[keccak256(bytes(zone_))];
        require(z.exists, "no zone");
        z.blocked = blocked_;
        emit ZoneBlocked(zone_, blocked_);
    }

    function setCyberPrice(uint256 price) external onlyOwner {
        cyberPrice = price;
    }

    function setFeeDivisor(uint256 divisor) external onlyOwner {
        require(divisor > 0, "zero divisor");
        feeDivisor = divisor;
    }

    function withdraw(address payable to) external onlyOwner {
        require(to != address(0), "zero recipient");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    // ── internals ────────────────────────────────────────────────────────

    function validLabel(string calldata label) external pure returns (bool) {
        return _validLabel(bytes(label));
    }

    function _validLabel(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > 63) return false;
        if (b[0] == 0x2D || b[b.length - 1] == 0x2D) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D)) return false;
        }
        return true;
    }

    function _lower(bytes1 c) internal pure returns (bytes1) {
        return c >= 0x41 && c <= 0x5A ? bytes1(uint8(c) + 32) : c;
    }

    function _openZone(string memory zone_) internal view returns (Zone memory z) {
        z = _zones[keccak256(bytes(zone_))];
        require(z.exists, "no such zone");
        require(!z.blocked, "zone blocked");
    }

    function _fee(Zone memory z) internal view returns (uint256) {
        if (z.token == address(0)) return cyberPrice;
        return IERC20(z.token).totalSupply() / feeDivisor;
    }

    function _register(string calldata label, string memory zone_, address to, uint256 paid)
        internal
        returns (uint256 tokenId)
    {
        require(_validLabel(bytes(label)), "invalid label");
        tokenId = tokenIdOf(label, zone_);
        require(_ownerOf(tokenId) == address(0), "name taken");

        _domains[tokenId] = Domain(label, zone_, uint64(block.timestamp));
        _mint(to, tokenId);
        emit DomainRegistered(tokenId, label, zone_, to, paid);
    }

    function _setRecord(uint256 id, string calldata key, string calldata value) internal {
        bytes memory k = bytes(key);
        require(k.length > 0 && k.length <= MAX_KEY, "key length");
        require(bytes(value).length <= MAX_VALUE, "value length");

        bytes32 kh = keccak256(k);
        uint256 slot = _recordSlot[id][kh];

        if (bytes(value).length == 0) {
            if (slot != 0) {
                string[] storage list = _recordKeys[id];
                uint256 last = list.length - 1;
                if (slot - 1 != last) {
                    list[slot - 1] = list[last];
                    _recordSlot[id][keccak256(bytes(list[slot - 1]))] = slot;
                }
                list.pop();
                delete _recordSlot[id][kh];
                delete _records[id][kh];
            }
        } else {
            if (slot == 0) {
                _recordKeys[id].push(key);
                _recordSlot[id][kh] = _recordKeys[id].length;
            }
            _records[id][kh] = value;
        }

        emit RecordSet(id, key, value);
    }
}
