// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title CyberiaShop — digital goods sold through escrow: keys, subscriptions,
///        accounts, domains, hosting, AI credits.
/// @notice A seller lists a lot: a price in the native coin (`address(0)`) or
///         an ERC-20, a stock of units, a category and a metadata URI. A lot
///         may also escrow one ERC-721 (a Cyberia domain, say), which then
///         travels to the buyer with the release.
///
///         The good itself is a secret, so it never touches storage. The
///         buyer names a messaging public key in `buy`, the seller has named
///         theirs in `list`, and `deliver` emits the secret encrypted to the
///         ECDH key the two share (the wallet chat's scheme). Only the event
///         carries it; the order records the block, so a reader asks for one
///         block's logs instead of scanning the chain.
///
///         The payment waits here. The buyer confirms, or lets the dispute
///         window pass and anyone may `release`; a seller who never delivers
///         is refunded in full after the delivery window. A dispute is decided
///         by a moderator, who can split the payment but can never send it
///         anywhere except the buyer, the seller and the fee address.
///
///         The fee is taken only from what the seller receives — a refund is
///         whole — and its address and rate are immutable.
///
///         Moderation is the contract's own: a moderator hides a lot or bans a
///         seller from listing, and three reports from buyers of a lot hide it
///         without anybody. Hiding stops new sales only; orders already paid
///         still finish or refund, so escrow is never stuck behind a ban.
contract CyberiaShop is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Key, Subscription, Account, GiftCard, Domain, Hosting, AiCredits, Other.
    uint8 public constant CATEGORY_COUNT = 8;
    uint16 public constant MAX_FEE_BPS = 500;
    /// Reports from distinct buyers that hide a lot until a moderator looks.
    uint16 public constant REPORTS_TO_HIDE = 3;

    enum State {
        None,
        Paid,
        Delivered,
        Disputed,
        Released,
        Refunded,
        Resolved
    }

    struct Listing {
        address seller;
        address payToken;
        uint256 price;
        uint32 stock;
        uint32 sold;
        uint8 category;
        bool closed;
        bool hidden;
        uint16 reports;
        /// Optional escrowed ERC-721; zero when the lot is only a secret.
        address nft;
        uint256 nftId;
        /// The seller's compressed secp256k1 messaging key (33 bytes).
        bytes sellerKey;
        string uri;
    }

    struct Order {
        uint256 listingId;
        address buyer;
        address payToken;
        uint256 amount;
        State state;
        uint64 paidAt;
        uint64 deliveredAt;
        uint64 deliveredBlock;
        bytes buyerKey;
    }

    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    uint64 public immutable deliveryWindow;
    uint64 public immutable disputeWindow;

    Listing[] private _listings;
    Order[] private _orders;

    mapping(address => bool) public moderators;
    mapping(address => bool) public banned;
    mapping(uint256 => mapping(address => bool)) public boughtFrom;
    mapping(uint256 => mapping(address => bool)) public reported;

    bool public paused;

    event Listed(uint256 indexed id, address indexed seller, uint8 category, address payToken, uint256 price, uint32 stock, address nft, uint256 nftId, string uri);
    event ListingUpdated(uint256 indexed id, uint256 price, uint32 stock);
    event ListingClosed(uint256 indexed id);
    event Ordered(uint256 indexed orderId, uint256 indexed listingId, address indexed buyer, uint256 amount);
    event Delivered(uint256 indexed orderId, bytes envelope);
    event Disputed(uint256 indexed orderId);
    event Released(uint256 indexed orderId, uint256 toSeller, uint256 fee);
    event Refunded(uint256 indexed orderId, uint256 toBuyer);
    event Resolved(uint256 indexed orderId, uint256 toBuyer, uint256 toSeller, uint256 fee);
    event Reported(uint256 indexed listingId, address indexed reporter, string reason);
    event Hidden(uint256 indexed listingId, bool hidden);
    event Banned(address indexed seller, bool banned);
    event ModeratorSet(address indexed account, bool allowed);
    event Paused(bool paused);

    modifier onlyModerator() {
        require(moderators[msg.sender] || msg.sender == owner(), "Shop: not moderator");
        _;
    }

    constructor(
        address owner_,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 deliveryWindow_,
        uint64 disputeWindow_
    ) {
        require(feeRecipient_ != address(0), "Shop: zero fee address");
        require(feeBps_ <= MAX_FEE_BPS, "Shop: fee too high");
        require(deliveryWindow_ >= 1 hours && disputeWindow_ >= 1 hours, "Shop: window too short");
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        deliveryWindow = deliveryWindow_;
        disputeWindow = disputeWindow_;
        _transferOwnership(owner_);
    }

    /* ------------------------------------------------------------ seller --- */

    function list(
        address payToken,
        uint256 price,
        uint32 stock,
        uint8 category,
        bytes calldata sellerKey,
        string calldata uri,
        address nft,
        uint256 nftId
    ) external nonReentrant returns (uint256 id) {
        require(!paused, "Shop: paused");
        require(!banned[msg.sender], "Shop: seller banned");
        require(price > 0 && stock > 0, "Shop: empty lot");
        require(category < CATEGORY_COUNT, "Shop: bad category");
        require(_isKey(sellerKey), "Shop: bad key");
        require(bytes(uri).length > 0 && bytes(uri).length <= 512, "Shop: bad uri");
        if (nft != address(0)) {
            require(stock == 1, "Shop: an NFT lot is one unit");
            IERC721(nft).transferFrom(msg.sender, address(this), nftId);
        }

        _listings.push(
            Listing({
                seller: msg.sender,
                payToken: payToken,
                price: price,
                stock: stock,
                sold: 0,
                category: category,
                closed: false,
                hidden: false,
                reports: 0,
                nft: nft,
                nftId: nftId,
                sellerKey: sellerKey,
                uri: uri
            })
        );
        id = _listings.length - 1;
        emit Listed(id, msg.sender, category, payToken, price, stock, nft, nftId, uri);
    }

    /// New price and stock for later sales; orders already paid keep theirs.
    function update(uint256 id, uint256 price, uint32 stock) external {
        Listing storage l = _listing(id);
        require(l.seller == msg.sender, "Shop: not seller");
        require(!l.closed, "Shop: closed");
        require(price > 0, "Shop: price=0");
        require(l.nft == address(0) || stock <= 1, "Shop: an NFT lot is one unit");
        l.price = price;
        l.stock = stock;
        emit ListingUpdated(id, price, stock);
    }

    /// Stop selling. An unsold escrowed NFT goes back to the seller.
    function close(uint256 id) external nonReentrant {
        Listing storage l = _listing(id);
        require(l.seller == msg.sender || moderators[msg.sender] || msg.sender == owner(), "Shop: not allowed");
        require(!l.closed, "Shop: closed");
        l.closed = true;
        l.stock = 0;
        if (l.nft != address(0) && l.sold == 0) {
            IERC721(l.nft).transferFrom(address(this), l.seller, l.nftId);
        }
        emit ListingClosed(id);
    }

    /// The secret, encrypted to the buyer. Allowed until the buyer refunds.
    function deliver(uint256 orderId, bytes calldata envelope) external {
        Order storage o = _order(orderId);
        require(_listings[o.listingId].seller == msg.sender, "Shop: not seller");
        require(o.state == State.Paid, "Shop: not awaiting delivery");
        require(envelope.length > 0 && envelope.length <= 8192, "Shop: bad envelope");
        o.state = State.Delivered;
        o.deliveredAt = uint64(block.timestamp);
        o.deliveredBlock = uint64(block.number);
        emit Delivered(orderId, envelope);
    }

    /// A seller may always give the money back instead of arguing.
    function sellerRefund(uint256 orderId) external nonReentrant {
        Order storage o = _order(orderId);
        require(_listings[o.listingId].seller == msg.sender, "Shop: not seller");
        require(o.state == State.Paid || o.state == State.Delivered || o.state == State.Disputed, "Shop: settled");
        _refund(orderId, o);
    }

    /* ------------------------------------------------------------- buyer --- */

    /// `maxPrice` is what the buyer agreed to, so a reprice that lands first
    /// reverts the purchase instead of charging more.
    function buy(uint256 id, bytes calldata buyerKey, uint256 maxPrice)
        external
        payable
        nonReentrant
        returns (uint256 orderId)
    {
        require(!paused, "Shop: paused");
        Listing storage l = _listing(id);
        require(!l.closed && !l.hidden, "Shop: not for sale");
        require(l.stock > 0, "Shop: sold out");
        require(msg.sender != l.seller, "Shop: own lot");
        require(!banned[l.seller], "Shop: seller banned");
        require(l.price <= maxPrice, "Shop: price changed");
        require(_isKey(buyerKey), "Shop: bad key");

        uint256 price = l.price;
        if (l.payToken == address(0)) {
            require(msg.value == price, "Shop: wrong value");
        } else {
            require(msg.value == 0, "Shop: no coin for a token lot");
            uint256 before = IERC20(l.payToken).balanceOf(address(this));
            IERC20(l.payToken).safeTransferFrom(msg.sender, address(this), price);
            require(IERC20(l.payToken).balanceOf(address(this)) - before == price, "Shop: fee-on-transfer token");
        }

        l.stock -= 1;
        l.sold += 1;
        boughtFrom[id][msg.sender] = true;

        _orders.push(
            Order({
                listingId: id,
                buyer: msg.sender,
                payToken: l.payToken,
                amount: price,
                state: State.Paid,
                paidAt: uint64(block.timestamp),
                deliveredAt: 0,
                deliveredBlock: 0,
                buyerKey: buyerKey
            })
        );
        orderId = _orders.length - 1;
        emit Ordered(orderId, id, msg.sender, price);
    }

    function confirm(uint256 orderId) external nonReentrant {
        Order storage o = _order(orderId);
        require(o.buyer == msg.sender, "Shop: not buyer");
        require(o.state == State.Delivered || o.state == State.Disputed, "Shop: nothing to confirm");
        _release(orderId, o);
    }

    function dispute(uint256 orderId) external {
        Order storage o = _order(orderId);
        require(o.buyer == msg.sender, "Shop: not buyer");
        require(o.state == State.Delivered, "Shop: not delivered");
        require(block.timestamp < o.deliveredAt + disputeWindow, "Shop: dispute window over");
        o.state = State.Disputed;
        emit Disputed(orderId);
    }

    /// A seller who never delivered: the whole payment back.
    function refund(uint256 orderId) external nonReentrant {
        Order storage o = _order(orderId);
        require(o.buyer == msg.sender, "Shop: not buyer");
        require(o.state == State.Paid, "Shop: not refundable");
        require(block.timestamp >= o.paidAt + deliveryWindow, "Shop: seller still has time");
        _refund(orderId, o);
    }

    /// After the dispute window anyone may pay the seller; the money can only
    /// go there.
    function release(uint256 orderId) external nonReentrant {
        Order storage o = _order(orderId);
        require(o.state == State.Delivered, "Shop: not releasable");
        require(block.timestamp >= o.deliveredAt + disputeWindow, "Shop: dispute window open");
        _release(orderId, o);
    }

    /// Only somebody who bought from a lot can report it, once.
    function report(uint256 id, string calldata reason) external {
        Listing storage l = _listing(id);
        require(boughtFrom[id][msg.sender], "Shop: buyers only");
        require(!reported[id][msg.sender], "Shop: already reported");
        require(bytes(reason).length <= 280, "Shop: reason too long");
        reported[id][msg.sender] = true;
        l.reports += 1;
        emit Reported(id, msg.sender, reason);
        if (l.reports >= REPORTS_TO_HIDE && !l.hidden) {
            l.hidden = true;
            emit Hidden(id, true);
        }
    }

    /* -------------------------------------------------------- moderation --- */

    /// Split a disputed payment. `buyerBps` of it goes back to the buyer, the
    /// rest to the seller less the fee. An NFT goes to whoever gets more.
    function resolve(uint256 orderId, uint16 buyerBps) external onlyModerator nonReentrant {
        Order storage o = _order(orderId);
        require(o.state == State.Disputed, "Shop: not disputed");
        require(buyerBps <= 10_000, "Shop: bps");
        o.state = State.Resolved;
        Listing storage l = _listings[o.listingId];

        uint256 toBuyer = (o.amount * buyerBps) / 10_000;
        uint256 sellerGross = o.amount - toBuyer;
        uint256 fee = (sellerGross * feeBps) / 10_000;
        _pay(o.payToken, o.buyer, toBuyer);
        _pay(o.payToken, l.seller, sellerGross - fee);
        _pay(o.payToken, feeRecipient, fee);
        if (l.nft != address(0)) {
            IERC721(l.nft).transferFrom(address(this), buyerBps > 5_000 ? l.seller : o.buyer, l.nftId);
        }
        emit Resolved(orderId, toBuyer, sellerGross - fee, fee);
    }

    function setHidden(uint256 id, bool hidden) external onlyModerator {
        _listing(id).hidden = hidden;
        emit Hidden(id, hidden);
    }

    function setBanned(address seller, bool value) external onlyModerator {
        banned[seller] = value;
        emit Banned(seller, value);
    }

    function setModerator(address account, bool allowed) external onlyOwner {
        moderators[account] = allowed;
        emit ModeratorSet(account, allowed);
    }

    /// Stops new lots and purchases only; everything already paid settles.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    /* ------------------------------------------------------------- views --- */

    function listingsLength() external view returns (uint256) {
        return _listings.length;
    }

    function ordersLength() external view returns (uint256) {
        return _orders.length;
    }

    function getListing(uint256 id) external view returns (Listing memory) {
        return _listing(id);
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _order(orderId);
    }

    /// The newest `limit` lots before `offset` from the end (0 = newest).
    function getListings(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory page)
    {
        (ids, page) = (new uint256[](0), new Listing[](0));
        uint256 n = _listings.length;
        if (offset >= n) return (ids, page);
        uint256 count = n - offset < limit ? n - offset : limit;
        ids = new uint256[](count);
        page = new Listing[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 id = n - 1 - offset - i;
            ids[i] = id;
            page[i] = _listings[id];
        }
    }

    function getOrders(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Order[] memory page)
    {
        (ids, page) = (new uint256[](0), new Order[](0));
        uint256 n = _orders.length;
        if (offset >= n) return (ids, page);
        uint256 count = n - offset < limit ? n - offset : limit;
        ids = new uint256[](count);
        page = new Order[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 id = n - 1 - offset - i;
            ids[i] = id;
            page[i] = _orders[id];
        }
    }

    /* ---------------------------------------------------------- internal --- */

    function _release(uint256 orderId, Order storage o) private {
        o.state = State.Released;
        Listing storage l = _listings[o.listingId];
        uint256 fee = (o.amount * feeBps) / 10_000;
        _pay(o.payToken, l.seller, o.amount - fee);
        _pay(o.payToken, feeRecipient, fee);
        if (l.nft != address(0)) {
            IERC721(l.nft).transferFrom(address(this), o.buyer, l.nftId);
        }
        emit Released(orderId, o.amount - fee, fee);
    }

    function _refund(uint256 orderId, Order storage o) private {
        o.state = State.Refunded;
        Listing storage l = _listings[o.listingId];
        _pay(o.payToken, o.buyer, o.amount);
        if (l.nft != address(0)) {
            // The one unit is not coming back on sale: the lot closes and the
            // NFT returns to the seller.
            l.closed = true;
            l.stock = 0;
            IERC721(l.nft).transferFrom(address(this), l.seller, l.nftId);
        }
        emit Refunded(orderId, o.amount);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "Shop: coin transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _listing(uint256 id) private view returns (Listing storage) {
        require(id < _listings.length, "Shop: no listing");
        return _listings[id];
    }

    function _order(uint256 id) private view returns (Order storage) {
        require(id < _orders.length, "Shop: no order");
        return _orders[id];
    }

    function _isKey(bytes calldata key) private pure returns (bool) {
        return key.length == 33 && (key[0] == 0x02 || key[0] == 0x03);
    }
}
