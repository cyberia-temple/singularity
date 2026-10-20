// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Buy and sell any NFT for any currency
/// @notice List an ERC-721 or ERC-1155 for CYBER or for any token -- a launched token is a currency
/// here from its first block -- and the NFT stays in your wallet until it sells. Or make an offer on
/// one token, or on any token of a collection, with the money held here until it is taken or
/// withdrawn. Creators get their ERC-2981 royalty (up to 10%) on every sale.
///
/// @dev Three things the old market got wrong are closed here. A buyer names the price and currency
/// they expect, so a seller cannot raise the price under a pending purchase. Listings expire and can
/// all be cancelled at once by bumping the seller's nonce, so a token that leaves and comes back does
/// not revive a forgotten price. And the NFT is checked to still be the seller's at the moment of sale.
contract NFTMarket is AccessManaged, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    address public constant NATIVE = address(0);
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_ROYALTY_BPS = 1_000;
    /// @notice An offer on this tokenId is an offer on any token of the collection
    uint256 public constant ANY_TOKEN = type(uint256).max;

    struct Listing {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 amount;
        address currency;
        uint256 price;
        uint64 expiry;
        uint64 nonce;
        bool is1155;
    }

    struct Offer {
        address buyer;
        address nft;
        uint256 tokenId;
        address currency;
        uint256 price;
        uint64 expiry;
        bool active;
    }

    uint256 public feeBps;
    address public feeRecipient;

    Listing[] internal _listings;
    Offer[] internal _offers;
    mapping(address seller => uint64) public sellerNonce;

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 amount,
        address currency,
        uint256 price,
        uint64 expiry
    );
    event Cancelled(uint256 indexed listingId);
    event AllCancelled(address indexed seller, uint64 nonce);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 amount, uint256 total);
    event OfferMade(uint256 indexed offerId, address indexed buyer, address indexed nft, uint256 tokenId, address currency, uint256 price);
    event OfferTaken(uint256 indexed offerId, address indexed seller, uint256 tokenId);
    event OfferCancelled(uint256 indexed offerId);
    event SettingsChanged();

    error BadPrice();
    error BadAmount();
    error NotOwner();
    error NotApproved();
    error NotSeller();
    error Inactive();
    error Expired();
    error PriceChanged();
    error WrongPayment();
    error BadCurrency();
    error TransferFailed();

    constructor(address authority, address feeRecipient_, uint256 feeBps_) AccessManaged(authority) {
        if (feeBps_ > MAX_FEE_BPS) revert BadPrice();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    // -------------------------------------------------------------------------------- listings

    /// @param amount 1 for an ERC-721; how many for an ERC-1155
    function list(address nft, uint256 tokenId, uint256 amount, address currency, uint256 price, uint64 expiry)
        external
        returns (uint256 listingId)
    {
        if (price == 0) revert BadPrice();
        if (expiry <= block.timestamp) revert Expired();
        bool is1155 = _is1155(nft);
        if (is1155 ? amount == 0 : amount != 1) revert BadAmount();
        if (!_owns(nft, tokenId, msg.sender, amount, is1155)) revert NotOwner();
        if (!_approved(nft, tokenId, msg.sender, is1155)) revert NotApproved();

        listingId = _listings.length;
        _listings.push(Listing(msg.sender, nft, tokenId, amount, currency, price, expiry, sellerNonce[msg.sender], is1155));
        emit Listed(listingId, msg.sender, nft, tokenId, amount, currency, price, expiry);
    }

    function cancel(uint256 listingId) external {
        Listing storage l = _listings[listingId];
        if (l.seller != msg.sender) revert NotSeller();
        l.amount = 0;
        emit Cancelled(listingId);
    }

    /// @notice Void every listing you have ever made
    function cancelAll() external {
        uint64 nonce = ++sellerNonce[msg.sender];
        emit AllCancelled(msg.sender, nonce);
    }

    /// @param price The unit price the buyer saw; the purchase fails if it has changed
    function buy(uint256 listingId, uint256 amount, address currency, uint256 price) external payable nonReentrant {
        Listing storage l = _listings[listingId];
        if (l.amount == 0 || l.nonce != sellerNonce[l.seller]) revert Inactive();
        if (block.timestamp > l.expiry) revert Expired();
        if (l.price != price || l.currency != currency) revert PriceChanged();
        if (amount == 0 || amount > l.amount) revert BadAmount();
        if (!_owns(l.nft, l.tokenId, l.seller, amount, l.is1155)) revert Inactive();

        l.amount -= amount;
        uint256 total = price * amount;

        if (currency == NATIVE) {
            if (msg.value != total) revert WrongPayment();
        } else {
            if (msg.value != 0) revert WrongPayment();
            IERC20(currency).safeTransferFrom(msg.sender, address(this), total);
        }
        _settle(l.nft, l.tokenId, currency, total, l.seller);
        _moveNft(l.nft, l.tokenId, l.seller, msg.sender, amount, l.is1155);

        emit Sold(listingId, msg.sender, amount, total);
    }

    // ---------------------------------------------------------------------------------- offers

    /// @notice Offer `price` of an ERC-20 for one token, or for any token of a collection (`ANY_TOKEN`)
    function makeOffer(address nft, uint256 tokenId, address currency, uint256 price, uint64 expiry)
        external
        nonReentrant
        returns (uint256 offerId)
    {
        if (currency == NATIVE) revert BadCurrency();
        if (price == 0) revert BadPrice();
        if (expiry <= block.timestamp) revert Expired();
        IERC20(currency).safeTransferFrom(msg.sender, address(this), price);

        offerId = _offers.length;
        _offers.push(Offer(msg.sender, nft, tokenId, currency, price, expiry, true));
        emit OfferMade(offerId, msg.sender, nft, tokenId, currency, price);
    }

    /// @notice Sell `tokenId` into an offer
    function acceptOffer(uint256 offerId, uint256 tokenId, uint256 price) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (!o.active) revert Inactive();
        if (block.timestamp > o.expiry) revert Expired();
        if (o.price != price) revert PriceChanged();
        if (o.tokenId != ANY_TOKEN && o.tokenId != tokenId) revert BadAmount();

        bool is1155 = _is1155(o.nft);
        if (!_owns(o.nft, tokenId, msg.sender, 1, is1155)) revert NotOwner();

        o.active = false;
        _settle(o.nft, tokenId, o.currency, price, msg.sender);
        _moveNft(o.nft, tokenId, msg.sender, o.buyer, 1, is1155);

        emit OfferTaken(offerId, msg.sender, tokenId);
    }

    /// @notice Take back an offer's money; anyone may return an expired one to its maker
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (!o.active) revert Inactive();
        if (msg.sender != o.buyer && block.timestamp <= o.expiry) revert NotSeller();
        o.active = false;
        IERC20(o.currency).safeTransfer(o.buyer, o.price);
        emit OfferCancelled(offerId);
    }

    // ----------------------------------------------------------------------------------- views

    function listing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function offer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    function listingsLength() external view returns (uint256) {
        return _listings.length;
    }

    function offersLength() external view returns (uint256) {
        return _offers.length;
    }

    // ------------------------------------------------------------------------------ governance

    function setFee(uint256 feeBps_, address feeRecipient_) external restricted {
        if (feeBps_ > MAX_FEE_BPS) revert BadPrice();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit SettingsChanged();
    }

    // ------------------------------------------------------------------------------- internals

    /// @dev Pays royalty, protocol fee and seller out of `total`, already held here.
    function _settle(address nft, uint256 tokenId, address currency, uint256 total, address seller) internal {
        uint256 fee = total * feeBps / BPS;
        (address royaltyTo, uint256 royalty) = _royalty(nft, tokenId, total);
        if (royalty > total - fee) royalty = total - fee;

        // A royalty receiver that refuses the coin must not be able to stop a sale: its cut goes
        // to the seller instead.
        if (royalty > 0 && currency == NATIVE) {
            (bool ok,) = royaltyTo.call{value: royalty}("");
            if (!ok) royalty = 0;
        } else {
            _pay(currency, royaltyTo, royalty);
        }

        _pay(currency, feeRecipient, fee);
        _pay(currency, seller, total - fee - royalty);
    }

    function _royalty(address nft, uint256 tokenId, uint256 total) internal view returns (address to, uint256 amount) {
        try IERC165(nft).supportsInterface(type(IERC2981).interfaceId) returns (bool supported) {
            if (!supported) return (address(0), 0);
        } catch {
            return (address(0), 0);
        }
        try IERC2981(nft).royaltyInfo(tokenId, total) returns (address receiver, uint256 value) {
            uint256 cap = total * MAX_ROYALTY_BPS / BPS;
            return (receiver, value > cap ? cap : value);
        } catch {
            return (address(0), 0);
        }
    }

    function _pay(address currency, address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        if (currency == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    function _moveNft(address nft, uint256 tokenId, address from, address to, uint256 amount, bool is1155) internal {
        if (is1155) IERC1155(nft).safeTransferFrom(from, to, tokenId, amount, "");
        else IERC721(nft).safeTransferFrom(from, to, tokenId);
    }

    function _is1155(address nft) internal view returns (bool) {
        try IERC165(nft).supportsInterface(type(IERC1155).interfaceId) returns (bool yes) {
            return yes;
        } catch {
            return false;
        }
    }

    function _owns(address nft, uint256 tokenId, address who, uint256 amount, bool is1155) internal view returns (bool) {
        if (is1155) return IERC1155(nft).balanceOf(who, tokenId) >= amount;
        try IERC721(nft).ownerOf(tokenId) returns (address owner) {
            return owner == who;
        } catch {
            return false;
        }
    }

    function _approved(address nft, uint256 tokenId, address who, bool is1155) internal view returns (bool) {
        if (IERC721(nft).isApprovedForAll(who, address(this))) return true;
        if (is1155) return false;
        return IERC721(nft).getApproved(tokenId) == address(this);
    }
}
