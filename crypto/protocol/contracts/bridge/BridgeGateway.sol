// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {BridgedToken} from "./BridgedToken.sol";

/// @title The one door between this chain and every chain the relayer serves
/// @notice Solana, TON, Bitcoin, Monero, Robinhood Chain and the rest are reached by a relayer that
/// watches deposits on one side and pays out on the other. This contract is the chain-side half of
/// that, and its job is to make the relayer's key worth as little as possible to whoever steals it:
///
///  - **In.** The relayer `release`s an asset against a deposit it saw elsewhere, naming that
///    deposit by a `sourceId`. A source can be released once, and each asset refills a rate-limited
///    allowance -- a stolen key mints at most one bucket of each asset, not the whole supply.
///  - **Out.** A user's `bridgeOut` puts the asset in escrow here, never burns it. The relayer pays
///    out on the destination, then `finalize`s (escrow burned, or kept as backing for a lockbox
///    asset). If it cannot pay, it `refund`s -- and if it never answers, the sender can refund
///    themselves after `refundDelay`. Capacity, payout, then burn: the order the bridge depends on.
///
/// Assets are either **wrapped** (a `BridgedToken` this gateway mints and burns) or **lockbox**
/// (a token or the native coin held here and released from what is held -- how native CYBER
/// leaves for other chains and comes back).
contract BridgeGateway is AccessManaged, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    enum Kind {
        None,
        Wrapped,
        Lockbox
    }

    enum Status {
        None,
        Pending,
        Finalized,
        Refunded
    }

    struct Asset {
        Kind kind;
        bool outboundEnabled;
        uint128 capacity;
        uint128 refillPerSecond;
        uint128 available;
        uint64 lastRefill;
        uint128 minOut;
    }

    struct Outbound {
        address sender;
        address token;
        uint128 amount;
        uint64 destChain;
        uint64 createdAt;
        Status status;
        bytes recipient;
    }

    address public immutable tokenImplementation;

    mapping(address token => Asset) public assets;
    mapping(address token => uint256) public escrowed;
    mapping(uint64 chain => bool) public isDestination;
    mapping(bytes32 sourceId => bool) public released;

    mapping(uint256 nonce => Outbound) internal _outbound;
    uint256 public outboundCount;

    /// @notice After this long a pending transfer may be refunded by its own sender; zero disables
    uint256 public refundDelay;
    bool public paused;

    event WrappedCreated(address indexed token, string symbol, uint8 decimals, uint64 originChain, bytes32 originId);
    event AssetSet(address indexed token, Kind kind, uint128 capacity, uint128 refillPerSecond, bool outboundEnabled);
    event DestinationSet(uint64 indexed chain, bool enabled);
    event Released(bytes32 indexed sourceId, address indexed token, address indexed to, uint256 amount);
    event BridgeOut(
        uint256 indexed nonce, address indexed sender, address indexed token, uint256 amount, uint64 destChain, bytes recipient
    );
    event Finalized(uint256 indexed nonce, bytes32 payoutRef);
    event Refunded(uint256 indexed nonce, address indexed by);
    event Paused(bool paused);
    event RefundDelaySet(uint256 delay);

    error IsPaused();
    error UnknownAsset();
    error AlreadyReleased();
    error RateLimited(uint256 available);
    error InsufficientReserve();
    error OutboundDisabled();
    error UnknownDestination();
    error BadAmount();
    error BadRecipient();
    error NotPending();
    error NotYetRefundable();
    error NativeTransferFailed();

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(address authority) AccessManaged(authority) {
        tokenImplementation = address(new BridgedToken(address(this)));
    }

    // ------------------------------------------------------------------------------------- in

    /// @notice Pay out an asset against a deposit seen on another chain
    /// @param sourceId Names the deposit: keccak256(source chain, transaction, output) as the relayer
    /// computes it. The same deposit can never be released twice.
    function release(address token, address to, uint256 amount, bytes32 sourceId)
        external
        restricted
        whenNotPaused
        nonReentrant
    {
        if (released[sourceId]) revert AlreadyReleased();
        if (to == address(0)) revert BadRecipient();
        if (amount == 0) revert BadAmount();
        released[sourceId] = true;

        Asset storage asset = assets[token];
        _consume(asset, amount);

        if (asset.kind == Kind.Wrapped) {
            BridgedToken(token).mint(to, amount);
        } else {
            if (_reserve(token) < amount) revert InsufficientReserve();
            _send(token, to, amount);
        }

        emit Released(sourceId, token, to, amount);
    }

    // ------------------------------------------------------------------------------------ out

    /// @notice Send an asset to another chain; it waits here in escrow until the relayer pays out
    /// @param recipient The address on the destination, in that chain's own encoding
    function bridgeOut(address token, uint256 amount, uint64 destChain, bytes calldata recipient)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 nonce)
    {
        Asset storage asset = assets[token];
        if (asset.kind == Kind.None) revert UnknownAsset();
        if (!asset.outboundEnabled) revert OutboundDisabled();
        if (!isDestination[destChain]) revert UnknownDestination();
        if (recipient.length == 0 || recipient.length > 128) revert BadRecipient();

        if (token == NATIVE) {
            if (msg.value != amount) revert BadAmount();
        } else {
            if (msg.value != 0) revert BadAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        if (amount == 0 || amount < asset.minOut || amount > type(uint128).max) revert BadAmount();

        escrowed[token] += amount;
        nonce = ++outboundCount;
        _outbound[nonce] = Outbound({
            sender: msg.sender,
            token: token,
            amount: uint128(amount),
            destChain: destChain,
            createdAt: uint64(block.timestamp),
            status: Status.Pending,
            recipient: recipient
        });

        emit BridgeOut(nonce, msg.sender, token, amount, destChain, recipient);
    }

    /// @notice The destination has paid: burn a wrapped escrow, keep a lockbox one as backing
    function finalize(uint256 nonce, bytes32 payoutRef) external restricted nonReentrant {
        Outbound storage out = _outbound[nonce];
        if (out.status != Status.Pending) revert NotPending();
        out.status = Status.Finalized;
        escrowed[out.token] -= out.amount;

        if (assets[out.token].kind == Kind.Wrapped) BridgedToken(out.token).burn(out.amount);

        emit Finalized(nonce, payoutRef);
    }

    /// @notice Give a pending transfer back to its sender -- the relayer at any time, the sender
    /// once `refundDelay` has passed without an answer
    function refund(uint256 nonce) external nonReentrant {
        Outbound storage out = _outbound[nonce];
        if (out.status != Status.Pending) revert NotPending();

        if (msg.sender == out.sender) {
            if (refundDelay == 0 || block.timestamp < out.createdAt + refundDelay) revert NotYetRefundable();
        } else {
            _checkCanCall(msg.sender, msg.data);
        }

        out.status = Status.Refunded;
        escrowed[out.token] -= out.amount;
        _send(out.token, out.sender, out.amount);

        emit Refunded(nonce, msg.sender);
    }

    function outbound(uint256 nonce) external view returns (Outbound memory) {
        return _outbound[nonce];
    }

    /// @notice What the relayer may still release of `token` right now
    function availableToRelease(address token) external view returns (uint256) {
        return _refilled(assets[token]);
    }

    // ----------------------------------------------------------------------------- governance

    /// @notice Clone a wrapped asset at an address derived from where it comes from
    function createWrapped(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint64 originChain,
        bytes32 originId
    ) external restricted returns (address token) {
        token = Clones.cloneDeterministic(tokenImplementation, keccak256(abi.encode(originChain, originId)));
        BridgedToken(token).initialize(name, symbol, decimals, originChain, originId);
        assets[token].kind = Kind.Wrapped;
        emit WrappedCreated(token, symbol, decimals, originChain, originId);
    }

    /// @notice Register a lockbox asset, or retune any asset's limits
    function setAsset(
        address token,
        Kind kind,
        uint128 capacity,
        uint128 refillPerSecond,
        bool outboundEnabled,
        uint128 minOut
    ) external restricted {
        Asset storage asset = assets[token];
        // A wrapped asset is born wrapped and stays wrapped; it cannot be re-declared a lockbox.
        if (asset.kind == Kind.Wrapped && kind != Kind.Wrapped) revert UnknownAsset();
        if (asset.kind != Kind.Wrapped && kind == Kind.Wrapped) revert UnknownAsset();

        // A first configuration starts with a full bucket; a retune keeps what has been used, as of
        // now, under the old rate.
        uint256 available = asset.lastRefill == 0 ? capacity : _refilled(asset);
        asset.kind = kind;
        asset.capacity = capacity;
        asset.refillPerSecond = refillPerSecond;
        asset.outboundEnabled = outboundEnabled;
        asset.minOut = minOut;
        asset.available = uint128(available > capacity ? capacity : available);
        asset.lastRefill = uint64(block.timestamp);

        emit AssetSet(token, kind, capacity, refillPerSecond, outboundEnabled);
    }

    function setDestination(uint64 chain, bool enabled) external restricted {
        isDestination[chain] = enabled;
        emit DestinationSet(chain, enabled);
    }

    function setRefundDelay(uint256 delay) external restricted {
        refundDelay = delay;
        emit RefundDelaySet(delay);
    }

    function setPaused(bool paused_) external restricted {
        paused = paused_;
        emit Paused(paused_);
    }

    receive() external payable {}

    // ------------------------------------------------------------------------------ internals

    function _consume(Asset storage asset, uint256 amount) internal {
        if (asset.kind == Kind.None) revert UnknownAsset();

        uint256 refilled = _refilled(asset);
        if (amount > refilled) revert RateLimited(refilled);

        asset.available = uint128(refilled - amount);
        asset.lastRefill = uint64(block.timestamp);
    }

    function _refilled(Asset storage asset) internal view returns (uint256 refilled) {
        refilled = uint256(asset.available) + (block.timestamp - asset.lastRefill) * asset.refillPerSecond;
        if (refilled > asset.capacity) refilled = asset.capacity;
    }

    /// @dev What a lockbox can pay out: everything held except what is waiting in escrow.
    function _reserve(address token) internal view returns (uint256) {
        uint256 held = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        uint256 locked = escrowed[token];
        return held > locked ? held - locked : 0;
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
