// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";

import {NFTMarket} from "../contracts/nft/NFTMarket.sol";
import {CyberiaNFT} from "../contracts/nft/CyberiaNFT.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract NFTMarketTest is Test {
    AccessManager authority;
    NFTMarket market;
    CyberiaNFT nft;
    MockERC20 moon;

    address router = makeAddr("router");
    address artist = makeAddr("artist");
    address collector = makeAddr("collector");
    address buyer = makeAddr("buyer");

    function setUp() public {
        authority = new AccessManager(address(this));
        market = new NFTMarket(address(authority), router, 200);
        nft = new CyberiaNFT();
        moon = new MockERC20("Moon", "MOON", 18);
        moon.mint(buyer, 1_000e18);
        vm.prank(buyer);
        moon.approve(address(market), type(uint256).max);
        vm.deal(buyer, 100 ether);
    }

    function _mintAndList(address currency, uint256 price) internal returns (uint256 tokenId, uint256 listingId) {
        vm.startPrank(artist);
        tokenId = nft.mint("ipfs://bafy", 500);
        nft.setApprovalForAll(address(market), true);
        listingId = market.list(address(nft), tokenId, 1, currency, price, uint64(block.timestamp + 7 days));
        vm.stopPrank();
    }

    function test_sellForALaunchedTokenWithRoyalty() public {
        (uint256 tokenId, uint256 listingId) = _mintAndList(address(moon), 100e18);

        // The artist sells it on to a collector, who relists.
        vm.prank(buyer);
        market.buy(listingId, 1, address(moon), 100e18);
        assertEq(nft.ownerOf(tokenId), buyer);
        assertEq(moon.balanceOf(router), 2e18, "2% protocol fee");
        assertEq(moon.balanceOf(artist), 98e18, "the artist is the seller and the royalty receiver");

        vm.startPrank(buyer);
        nft.setApprovalForAll(address(market), true);
        uint256 relist = market.list(address(nft), tokenId, 1, address(moon), 200e18, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        moon.mint(collector, 200e18);
        vm.startPrank(collector);
        moon.approve(address(market), 200e18);
        market.buy(relist, 1, address(moon), 200e18);
        vm.stopPrank();

        assertEq(moon.balanceOf(artist), 98e18 + 10e18, "5% royalty on the resale");
    }

    function test_priceChangeUnderABuyerReverts() public {
        (, uint256 listingId) = _mintAndList(address(0), 1 ether);
        vm.prank(buyer);
        vm.expectRevert(NFTMarket.PriceChanged.selector);
        market.buy{value: 2 ether}(listingId, 1, address(0), 2 ether);
    }

    function test_cancelAllVoidsForgottenListings() public {
        (uint256 tokenId, uint256 listingId) = _mintAndList(address(0), 1 ether);

        // The artist moves the NFT away and back, then cancels everything they ever listed.
        vm.startPrank(artist);
        nft.transferFrom(artist, collector, tokenId);
        vm.stopPrank();
        vm.prank(collector);
        nft.transferFrom(collector, artist, tokenId);
        vm.prank(artist);
        market.cancelAll();

        vm.prank(buyer);
        vm.expectRevert(NFTMarket.Inactive.selector);
        market.buy{value: 1 ether}(listingId, 1, address(0), 1 ether);
    }

    function test_listingsExpire() public {
        (, uint256 listingId) = _mintAndList(address(0), 1 ether);
        skip(8 days);
        vm.prank(buyer);
        vm.expectRevert(NFTMarket.Expired.selector);
        market.buy{value: 1 ether}(listingId, 1, address(0), 1 ether);
    }

    function test_collectionOfferIsTaken() public {
        vm.prank(artist);
        uint256 tokenId = nft.mint("text only, no image", 0);

        uint256 anyToken = market.ANY_TOKEN();
        vm.prank(buyer);
        uint256 offerId = market.makeOffer(address(nft), anyToken, address(moon), 50e18, uint64(block.timestamp + 1 days));

        vm.startPrank(artist);
        nft.setApprovalForAll(address(market), true);
        market.acceptOffer(offerId, tokenId, 50e18);
        vm.stopPrank();

        assertEq(nft.ownerOf(tokenId), buyer);
        assertEq(moon.balanceOf(artist), 49e18);
    }

    function test_expiredOfferReturnsToItsMaker() public {
        vm.prank(buyer);
        uint256 offerId = market.makeOffer(address(nft), 1, address(moon), 50e18, uint64(block.timestamp + 1 days));
        skip(2 days);
        market.cancelOffer(offerId); // anyone, once expired
        assertEq(moon.balanceOf(buyer), 1_000e18);
    }
}
