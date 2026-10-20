// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ILaunchRegistry, IZoneRegistry} from "../launch/interfaces/IEconomyModules.sol";

/// @title Names on Cyberia: one system, as NFTs, in zones that tokens open
/// @notice The old chain had three naming systems -- profile nicknames, `.cyber` names, and domain
/// NFTs. This is the one that replaces all of them.
///
///  - **A name is an NFT** (`lain.cyber`): held, sent, sold and shown like any other.
///  - **Your primary name is your nickname.** Point your address at one of your names and every
///    screen that shows an address can show that instead; it stops counting the moment you no
///    longer hold the name.
///  - **Records** (`A`, `TXT`, `ipfs`, `addr`, `<sub>/<TYPE>`, ...) are a key/value bag the DNS
///    gateway turns into answers. They belong to the holder: a name that changes hands starts with
///    none of the previous holder's records.
///  - **Zones.** `.cyber` is paid for in CYBER. Every other zone is opened by a launched token whose
///    name and ticker spell it (`.moon` / `DOTMOON` opens `.moon`), and its names are paid for by
///    burning `totalSupply / feeDivisor` of that token.
contract Domains is ERC721, AccessManaged, IZoneRegistry {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    string public constant ROOT_ZONE = "cyber";
    uint256 public constant MAX_KEY = 64;
    uint256 public constant MAX_VALUE = 1024;

    struct Zone {
        address token;
        uint64 createdAt;
        bool exists;
        bool blocked;
    }

    struct Name {
        string label;
        string zone;
        uint64 registeredAt;
    }

    ILaunchRegistry public immutable launchpad;

    /// @notice Where `.cyber` registrations are paid
    address public treasury;

    /// @notice Price of a `.cyber` name, in wei of CYBER
    uint256 public rootPrice;

    /// @notice A token zone's fee is `totalSupply / feeDivisor` of its token
    uint256 public feeDivisor = 1_000_000;

    mapping(bytes32 zoneHash => Zone) internal _zones;
    string[] internal _zoneLabels;
    mapping(address token => string) public zoneOfToken;
    mapping(bytes32 labelHash => bool) public reserved;

    mapping(uint256 tokenId => Name) internal _names;
    mapping(address owner => uint256 tokenId) internal _primary;

    /// @dev Records are filed under the holder's tenure, which starts again on every transfer.
    mapping(uint256 tokenId => uint256) public tenure;
    mapping(uint256 tokenId => mapping(uint256 tenure => mapping(bytes32 key => string))) internal _records;
    mapping(uint256 tokenId => mapping(uint256 tenure => string[])) internal _recordKeys;
    mapping(uint256 tokenId => mapping(uint256 tenure => mapping(bytes32 key => uint256))) internal _recordSlot;

    event ZoneCreated(string zone, address indexed token);
    event ZoneBlocked(string zone, bool blocked);
    event NameRegistered(uint256 indexed tokenId, string label, string zone, address indexed owner, uint256 paid);
    event RecordSet(uint256 indexed tokenId, string key, string value);
    event PrimarySet(address indexed owner, uint256 indexed tokenId);
    event SettingsChanged();

    error NotLaunched();
    error NotAZoneToken();
    error ZoneExists();
    error NoSuchZone();
    error ZoneIsBlocked();
    error InvalidLabel();
    error NameTaken();
    error Reserved();
    error WrongPayment();
    error NotNameOwner();
    error LengthMismatch();
    error BadRecord();
    error TransferFailed();
    error ZeroAddress();

    constructor(address authority, ILaunchRegistry launchpad_, address treasury_, uint256 rootPrice_)
        ERC721("Cyberia Names", "NAME")
        AccessManaged(authority)
    {
        launchpad = launchpad_;
        treasury = treasury_;
        rootPrice = rootPrice_;
        _zones[keccak256(bytes(ROOT_ZONE))] = Zone(address(0), uint64(block.timestamp), true, false);
        _zoneLabels.push(ROOT_ZONE);
        emit ZoneCreated(ROOT_ZONE, address(0));
    }

    // ---------------------------------------------------------------------------------- zones

    /// @inheritdoc IZoneRegistry
    function createZone(address token) external returns (string memory label) {
        if (!launchpad.isLaunched(token)) revert NotLaunched();
        if (bytes(zoneOfToken[token]).length != 0) revert ZoneExists();

        label = zoneFromToken(IERC20Metadata(token).name(), IERC20Metadata(token).symbol());
        if (bytes(label).length == 0) revert NotAZoneToken();

        bytes32 zoneHash = keccak256(bytes(label));
        if (_zones[zoneHash].exists) revert ZoneExists();

        _zones[zoneHash] = Zone(token, uint64(block.timestamp), true, false);
        _zoneLabels.push(label);
        zoneOfToken[token] = label;
        emit ZoneCreated(label, token);
    }

    /// @notice The zone a token's name and ticker spell, or "": `.moon` + `DOTMOON` → `moon`
    function zoneFromToken(string memory name_, string memory symbol_) public pure returns (string memory) {
        bytes memory n = bytes(name_);
        bytes memory s = bytes(symbol_);
        if (n.length < 2 || n[0] != 0x2E || s.length != n.length + 2) return "";

        bytes memory z = new bytes(n.length - 1);
        for (uint256 i = 1; i < n.length; i++) {
            z[i - 1] = _lower(n[i]);
        }
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

    function zones() external view returns (string[] memory labels, address[] memory tokens, bool[] memory blocked) {
        uint256 n = _zoneLabels.length;
        labels = new string[](n);
        tokens = new address[](n);
        blocked = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            Zone memory z = _zones[keccak256(bytes(_zoneLabels[i]))];
            (labels[i], tokens[i], blocked[i]) = (_zoneLabels[i], z.token, z.blocked);
        }
    }

    // ---------------------------------------------------------------------------------- names

    function tokenIdOf(string memory label, string memory zone_) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(label, ".", zone_)));
    }

    /// @notice Register `label.zone` to the caller: `.cyber` for exactly `rootPrice` in CYBER, a token
    /// zone by burning its fee in the zone's token (approve it first)
    function register(string calldata label, string calldata zone_) external payable returns (uint256 tokenId) {
        Zone memory z = _openZone(zone_);
        uint256 fee = _fee(z);

        if (z.token == address(0)) {
            if (msg.value != fee) revert WrongPayment();
            if (reserved[keccak256(bytes(label))]) revert Reserved();
            if (fee > 0) {
                (bool ok,) = treasury.call{value: fee}("");
                if (!ok) revert TransferFailed();
            }
        } else {
            if (msg.value != 0) revert WrongPayment();
            if (fee > 0) IERC20(z.token).safeTransferFrom(msg.sender, BURN, fee);
        }

        tokenId = _register(label, zone_, msg.sender, fee);
    }

    /// @notice A free `.cyber` name: the project's own, or onboarding someone who holds no gas
    /// @dev Reserved names can only be handed out this way.
    function registerFor(string calldata label, address to) external restricted returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        _openZone(ROOT_ZONE);
        return _register(label, ROOT_ZONE, to, 0);
    }

    function available(string calldata label, string calldata zone_) external view returns (bool) {
        Zone memory z = _zones[keccak256(bytes(zone_))];
        if (!z.exists || z.blocked || !_validLabel(bytes(label))) return false;
        if (z.token == address(0) && reserved[keccak256(bytes(label))]) return false;
        return _ownerOf(tokenIdOf(label, zone_)) == address(0);
    }

    function nameOf(uint256 tokenId) external view returns (string memory label, string memory zone_, uint64 registeredAt) {
        Name memory n = _names[tokenId];
        return (n.label, n.zone, n.registeredAt);
    }

    // -------------------------------------------------------------------------------- primary

    /// @notice Make one of your names the one your address shows as
    function setPrimary(uint256 tokenId) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotNameOwner();
        _primary[msg.sender] = tokenId;
        emit PrimarySet(msg.sender, tokenId);
    }

    /// @notice `owner`'s primary name as `label.zone`, or "" when it has none it still holds
    function primaryName(address owner) external view returns (string memory) {
        uint256 tokenId = _primary[owner];
        if (tokenId == 0 || _ownerOf(tokenId) != owner) return "";
        Name memory n = _names[tokenId];
        return string.concat(n.label, ".", n.zone);
    }

    // -------------------------------------------------------------------------------- records

    /// @notice Write records; an empty value deletes one
    function setRecords(uint256 tokenId, string[] calldata keys, string[] calldata values) external {
        if (keys.length != values.length) revert LengthMismatch();
        if (!_isAuthorized(_ownerOf(tokenId), msg.sender, tokenId)) revert NotNameOwner();
        uint256 t = tenure[tokenId];
        for (uint256 i = 0; i < keys.length; i++) {
            _setRecord(tokenId, t, keys[i], values[i]);
        }
    }

    /// @notice What the DNS gateway asks: who holds `label.zone` (zero when unregistered or its
    /// zone is blocked) and the asked-for records, "" where unset
    function resolve(string calldata label, string calldata zone_, string[] calldata keys)
        external
        view
        returns (address owner, string[] memory values)
    {
        uint256 tokenId = tokenIdOf(label, zone_);
        Zone memory z = _zones[keccak256(bytes(zone_))];
        owner = z.exists && !z.blocked ? _ownerOf(tokenId) : address(0);
        uint256 t = tenure[tokenId];
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = _records[tokenId][t][keccak256(bytes(keys[i]))];
        }
    }

    function records(uint256 tokenId) external view returns (string[] memory keys, string[] memory values) {
        uint256 t = tenure[tokenId];
        keys = _recordKeys[tokenId][t];
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = _records[tokenId][t][keccak256(bytes(keys[i]))];
        }
    }

    // ------------------------------------------------------------------------------- metadata

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Name memory n = _names[tokenId];
        // Labels are [a-z0-9-], so the name needs no escaping in JSON or SVG.
        string memory full = string.concat(n.label, ".", n.zone);
        uint256 len = bytes(full).length;
        string memory size = len <= 12 ? "40" : len <= 20 ? "28" : len <= 32 ? "18" : "11";

        bytes memory svg = abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>",
            "<rect width='400' height='400' fill='#0b0b10'/>",
            "<rect x='16' y='16' width='368' height='368' fill='none' stroke='#2a2a3a'/>",
            "<text x='32' y='58' fill='#c08cff' font-family='monospace' font-size='14' letter-spacing='3'>CYBERIA NAME</text>",
            "<text x='32' y='212' fill='#e8e8f0' font-family='monospace' font-size='",
            size,
            "'>",
            full,
            "</text><text x='32' y='360' fill='#7a7a90' font-family='monospace' font-size='13'>.",
            n.zone,
            " zone</text></svg>"
        );
        bytes memory json = abi.encodePacked(
            '{"name":"',
            full,
            '","description":"A Cyberia name. Whoever holds it controls the records of ',
            full,
            '.","image":"data:image/svg+xml;base64,',
            Base64.encode(svg),
            '","attributes":[{"trait_type":"zone","value":"',
            n.zone,
            '"},{"trait_type":"length","value":',
            bytes(n.label).length.toString(),
            "}]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    // ----------------------------------------------------------------------------- governance

    function reserve(string[] calldata labels, bool isReserved) external restricted {
        for (uint256 i = 0; i < labels.length; i++) {
            reserved[keccak256(bytes(labels[i]))] = isReserved;
        }
        emit SettingsChanged();
    }

    /// @notice For abuse only: a blocked zone resolves nothing and sells nothing; its NFTs stay put
    function blockZone(string calldata zone_, bool blocked_) external restricted {
        Zone storage z = _zones[keccak256(bytes(zone_))];
        if (!z.exists) revert NoSuchZone();
        z.blocked = blocked_;
        emit ZoneBlocked(zone_, blocked_);
    }

    function setPricing(uint256 rootPrice_, uint256 feeDivisor_, address treasury_) external restricted {
        if (feeDivisor_ == 0 || treasury_ == address(0)) revert ZeroAddress();
        rootPrice = rootPrice_;
        feeDivisor = feeDivisor_;
        treasury = treasury_;
        emit SettingsChanged();
    }

    // ------------------------------------------------------------------------------ internals

    /// @dev A transfer starts a new tenure: the next holder sees none of the last one's records.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && from != to) tenure[tokenId] += 1;
    }

    function _register(string calldata label, string memory zone_, address to, uint256 paid)
        internal
        returns (uint256 tokenId)
    {
        if (!_validLabel(bytes(label))) revert InvalidLabel();
        tokenId = tokenIdOf(label, zone_);
        if (_ownerOf(tokenId) != address(0)) revert NameTaken();

        _names[tokenId] = Name(label, zone_, uint64(block.timestamp));
        _mint(to, tokenId);
        emit NameRegistered(tokenId, label, zone_, to, paid);
    }

    function _openZone(string memory zone_) internal view returns (Zone memory z) {
        z = _zones[keccak256(bytes(zone_))];
        if (!z.exists) revert NoSuchZone();
        if (z.blocked) revert ZoneIsBlocked();
    }

    function _fee(Zone memory z) internal view returns (uint256) {
        if (z.token == address(0)) return rootPrice;
        return IERC20(z.token).totalSupply() / feeDivisor;
    }

    function _setRecord(uint256 tokenId, uint256 t, string calldata key, string calldata value) internal {
        bytes memory k = bytes(key);
        if (k.length == 0 || k.length > MAX_KEY || bytes(value).length > MAX_VALUE) revert BadRecord();

        bytes32 kh = keccak256(k);
        uint256 slot = _recordSlot[tokenId][t][kh];

        if (bytes(value).length == 0) {
            if (slot != 0) {
                string[] storage list = _recordKeys[tokenId][t];
                uint256 last = list.length - 1;
                if (slot - 1 != last) {
                    list[slot - 1] = list[last];
                    _recordSlot[tokenId][t][keccak256(bytes(list[slot - 1]))] = slot;
                }
                list.pop();
                delete _recordSlot[tokenId][t][kh];
                delete _records[tokenId][t][kh];
            }
        } else {
            if (slot == 0) {
                _recordKeys[tokenId][t].push(key);
                _recordSlot[tokenId][t][kh] = _recordKeys[tokenId][t].length;
            }
            _records[tokenId][t][kh] = value;
        }

        emit RecordSet(tokenId, key, value);
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
}
