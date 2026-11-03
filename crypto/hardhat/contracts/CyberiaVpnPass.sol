// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title CyberiaVpnPass — days of Cyberia VPN, paid for in the coin.
/// @notice A pass is one number per address: the unix second its access ends.
///         Buying adds days to whatever is left, never resets it, so paying
///         early loses nothing. Every node of the VPN reads the same number
///         (from `PassBought`, or `expiresAt`) and lets the address in until
///         then; nothing here knows which node anybody uses, and nothing has
///         to.
///
///         The payment is split in the transaction that makes it: `feeBps` to
///         the protocol's fee address, the rest to `treasury` — the operators'
///         side, which is the VPN service's `ServiceTreasury` once that exists
///         (it pays the nodes by the second through `CyberiaCompute`) and an
///         operator's own address until then. Nothing is held here, so there is
///         nothing to sweep and nothing to steal.
///
///         The price is exact: `msg.value` must equal `pricePerDay * days`. A
///         price change that lands first makes the purchase revert instead of
///         charging a number the buyer never saw, and there is never change to
///         hand back.
contract CyberiaVpnPass {
    /// @notice Sets the price, the split and the pause. Cannot touch a pass.
    address public owner;

    /// @notice Wei of the native coin per day of access.
    uint256 public pricePerDay;

    /// @notice Protocol share of each payment, in basis points.
    uint16 public feeBps;

    /// @notice Where the protocol share goes.
    address payable public feeRecipient;

    /// @notice Where the rest goes: whoever pays for the nodes.
    address payable public treasury;

    /// @notice A paused pass sells nothing; passes already sold keep running.
    bool public paused;

    /// @notice Unix second each address's access ends; 0 = never bought.
    mapping(address => uint64) public expiresAt;

    /// @notice The protocol share can never exceed 20%.
    uint16 public constant MAX_FEE_BPS = 2_000;

    /// @notice One purchase covers at most a year, so a typo cannot buy a decade.
    uint32 public constant MAX_DAYS = 366;

    event PassBought(
        address indexed user,
        address indexed payer,
        uint32 days_,
        uint64 expiresAt,
        uint256 paid,
        uint256 fee
    );
    event PriceSet(uint256 pricePerDay);
    event FeeSet(uint16 feeBps, address feeRecipient);
    event TreasurySet(address treasury);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error Paused();
    error BadDays();
    error WrongPayment(uint256 expected);
    error ZeroAddress();
    error FeeTooHigh();
    error PayoutFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        uint256 pricePerDay_,
        uint16 feeBps_,
        address payable feeRecipient_,
        address payable treasury_
    ) {
        if (owner_ == address(0) || feeRecipient_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();

        owner = owner_;
        pricePerDay = pricePerDay_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        treasury = treasury_;

        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Whether `user` may connect right now.
    function isActive(address user) external view returns (bool) {
        return expiresAt[user] > block.timestamp;
    }

    /// @notice What `days_` of access cost at the current price.
    function quote(uint32 days_) public view returns (uint256) {
        return pricePerDay * days_;
    }

    /// @notice Buy `days_` of access for `user` — yourself, or anybody you are
    ///         paying for. Days are added to what is left, never reset.
    function buy(address user, uint32 days_) external payable returns (uint64) {
        if (paused) revert Paused();
        if (user == address(0)) revert ZeroAddress();
        if (days_ == 0 || days_ > MAX_DAYS) revert BadDays();

        uint256 expected = quote(days_);
        if (msg.value != expected) revert WrongPayment(expected);

        uint64 from = expiresAt[user];
        if (from < block.timestamp) {
            from = uint64(block.timestamp);
        }
        uint64 until = from + uint64(days_) * 1 days;
        expiresAt[user] = until;

        uint256 fee = (msg.value * feeBps) / 10_000;
        emit PassBought(user, msg.sender, days_, until, msg.value, fee);

        _pay(feeRecipient, fee);
        _pay(treasury, msg.value - fee);

        return until;
    }

    function setPrice(uint256 pricePerDay_) external onlyOwner {
        pricePerDay = pricePerDay_;
        emit PriceSet(pricePerDay_);
    }

    function setFee(uint16 feeBps_, address payable feeRecipient_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeSet(feeBps_, feeRecipient_);
    }

    function setTreasury(address payable treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _pay(address payable to, uint256 amount) private {
        if (amount == 0) {
            return;
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }
}
