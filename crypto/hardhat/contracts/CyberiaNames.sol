// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CyberiaNames — the `.cyber` namespace, kept on Cyberia.
/// @notice A name is one DNS label (`lain` in `lain.cyber`) owned by an
///         address, plus a bag of string records its owner writes. The
///         contract knows nothing about DNS: it stores `key → value` and
///         `services/cyberia-dns` turns those into answers (`A`, `AAAA`,
///         `CNAME`, `TXT`, `MX`, `ipfs`, and `<sub>/<TYPE>` for anything
///         under the name). Validating a value is the gateway's job — a bad
///         record is skipped there, never a reason to brick a name here.
///
///         Labels follow the DNS hostname rule so every name is a name a
///         resolver can actually ask for: lowercase `[a-z0-9-]`, 1–63
///         characters, no hyphen at either end. Lowercase-only makes
///         uniqueness case-insensitive by construction, exactly as
///         CyberiaProfile's nicknames.
///
///         Names do not expire. Registration costs `price` in native CYBER
///         (the owner sets it; it exists so the namespace cannot be taken
///         whole for gas money), which accrues here until `withdraw`.
contract CyberiaNames is Ownable {
    struct Name {
        address owner;
        uint64 registeredAt;
    }

    uint256 public constant MAX_KEY = 64;
    uint256 public constant MAX_VALUE = 1024;

    /// @notice Registration fee in wei of native CYBER.
    uint256 public price;

    /// @notice Name record, keyed by keccak256(bytes(label)).
    mapping(bytes32 => Name) public names;

    /// @notice The label behind a key, so an owner's names can be listed.
    mapping(bytes32 => string) public labelOf;

    mapping(bytes32 => mapping(bytes32 => string)) private _records;
    mapping(bytes32 => string[]) private _recordKeys;
    mapping(bytes32 => mapping(bytes32 => uint256)) private _recordSlot; // index + 1

    event Registered(string label, address indexed owner, uint256 paid);
    event Transferred(string label, address indexed from, address indexed to);
    event RecordSet(string label, string key, string value);
    event PriceChanged(uint256 price);

    constructor(uint256 initialPrice) {
        price = initialPrice;
        emit PriceChanged(initialPrice);
    }

    modifier onlyNameOwner(string calldata label) {
        require(names[keccak256(bytes(label))].owner == msg.sender, "not name owner");
        _;
    }

    // ── names ────────────────────────────────────────────────────────────

    /// @notice Register a free label to the caller for exactly `price`.
    function register(string calldata label) external payable {
        require(msg.value == price, "wrong price");
        _register(label, msg.sender, msg.value);
    }

    /// @notice Register on somebody's behalf without a fee: reserving the
    ///         project's own names, or onboarding a user who holds no gas.
    function registerFor(string calldata label, address to) external onlyOwner {
        require(to != address(0), "zero owner");
        _register(label, to, 0);
    }

    function transfer(string calldata label, address to) external onlyNameOwner(label) {
        require(to != address(0), "zero owner");
        names[keccak256(bytes(label))].owner = to;
        emit Transferred(label, msg.sender, to);
    }

    function available(string calldata label) external view returns (bool) {
        return validLabel(label) && names[keccak256(bytes(label))].owner == address(0);
    }

    function ownerOfName(string calldata label) external view returns (address) {
        return names[keccak256(bytes(label))].owner;
    }

    // ── records ──────────────────────────────────────────────────────────

    /// @notice Write one record; an empty value deletes it.
    function setRecord(string calldata label, string calldata key, string calldata value)
        external
        onlyNameOwner(label)
    {
        _setRecord(keccak256(bytes(label)), label, key, value);
    }

    function setRecords(string calldata label, string[] calldata keys, string[] calldata values)
        external
        onlyNameOwner(label)
    {
        require(keys.length == values.length, "length mismatch");
        bytes32 node = keccak256(bytes(label));

        for (uint256 i = 0; i < keys.length; i++) {
            _setRecord(node, label, keys[i], values[i]);
        }
    }

    function record(string calldata label, string calldata key) external view returns (string memory) {
        return _records[keccak256(bytes(label))][keccak256(bytes(key))];
    }

    /// @notice Everything the gateway needs for one name in one call: the
    ///         owner (zero = not registered) and the asked-for records, ""
    ///         where unset.
    function resolve(string calldata label, string[] calldata keys)
        external
        view
        returns (address owner, string[] memory values)
    {
        bytes32 node = keccak256(bytes(label));
        owner = names[node].owner;
        values = new string[](keys.length);

        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = _records[node][keccak256(bytes(keys[i]))];
        }
    }

    /// @notice Every record a name carries, for the owner's own editor.
    function records(string calldata label) external view returns (string[] memory keys, string[] memory values) {
        bytes32 node = keccak256(bytes(label));
        keys = _recordKeys[node];
        values = new string[](keys.length);

        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = _records[node][keccak256(bytes(keys[i]))];
        }
    }

    // ── admin ────────────────────────────────────────────────────────────

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceChanged(newPrice);
    }

    function withdraw(address payable to) external onlyOwner {
        require(to != address(0), "zero recipient");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    // ── internals ────────────────────────────────────────────────────────

    function validLabel(string calldata label) public pure returns (bool) {
        bytes memory b = bytes(label);
        if (b.length == 0 || b.length > 63) return false;
        if (b[0] == 0x2D || b[b.length - 1] == 0x2D) return false;

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D)) return false;
        }

        return true;
    }

    function _register(string calldata label, address to, uint256 paid) internal {
        require(validLabel(label), "invalid label");
        bytes32 node = keccak256(bytes(label));
        require(names[node].owner == address(0), "name taken");

        names[node] = Name({owner: to, registeredAt: uint64(block.timestamp)});
        labelOf[node] = label;
        emit Registered(label, to, paid);
    }

    function _setRecord(bytes32 node, string calldata label, string calldata key, string calldata value) internal {
        bytes memory k = bytes(key);
        require(k.length > 0 && k.length <= MAX_KEY, "key length");
        require(bytes(value).length <= MAX_VALUE, "value length");

        bytes32 kh = keccak256(k);
        uint256 slot = _recordSlot[node][kh];

        if (bytes(value).length == 0) {
            if (slot != 0) {
                string[] storage list = _recordKeys[node];
                uint256 last = list.length - 1;

                if (slot - 1 != last) {
                    list[slot - 1] = list[last];
                    _recordSlot[node][keccak256(bytes(list[slot - 1]))] = slot;
                }

                list.pop();
                delete _recordSlot[node][kh];
                delete _records[node][kh];
            }
        } else {
            if (slot == 0) {
                _recordKeys[node].push(key);
                _recordSlot[node][kh] = _recordKeys[node].length;
            }

            _records[node][kh] = value;
        }

        emit RecordSet(label, key, value);
    }
}
