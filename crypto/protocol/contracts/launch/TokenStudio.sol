// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IV3Factory, IV3PositionManager, IWETH9} from "../interfaces/IV3.sol";
import {ILending} from "../lending/interfaces/ILending.sol";
import {OracleFactory} from "../oracles/OracleFactory.sol";
import {LiquidityVaultFactory} from "../liquidity/LiquidityVaultFactory.sol";
import {StudioToken} from "../tokens/StudioToken.sol";
import {LaunchLocker} from "./LaunchLocker.sol";
import {Launchpad} from "./Launchpad.sol";

/// @title Make any token, with the economy a launch gets
/// @notice The launchpad makes one kind of token: a fixed supply, all of it in the pool. The studio
/// makes the token its creator describes, and gives it the same economy:
///
///  - **the supply** -- how much goes into the pool, and how much is minted straight to the
///    addresses the creator names (a team, a treasury, themselves);
///  - **a minter** -- someone who may mint more, to any address, up to a ceiling; or nobody, for a
///    fixed supply. The minter can hand the right on (to the token's own DAO timelock, say) or give
///    it up for good;
///  - **the market** -- the pool is paired with the CYBER sent along and its full-range liquidity is
///    locked in `LaunchLocker` forever, with the fee named by the creator and shared with the
///    creator, the holders and the protocol, exactly as a launch's;
///  - **the kit** -- credit, a farm and a DAO, chosen per token and openable later by anyone.
///
/// Name zones are the launchpad's alone: `Domains` opens a zone only for a token the launchpad
/// launched, so a studio token asks for none.
///
/// @dev A `Launchpad` with a second way in: the registry, the kit, the fee split and every governed
/// setting are the launchpad's own code, so `economyOf` reads the same for both and a reader of one
/// reads the other. The inherited `launch` still works and makes a fixed-supply launch token here.
///
/// A minted supply changes what locked liquidity promises. A launch's pool holds the whole supply,
/// so the CYBER in it can never come back out; a minter can mint and sell into the pool. What the
/// minter may do is on chain (`StudioToken.minter`, `maxSupply`) for anyone to read before buying,
/// lending or borrowing against the token.
contract TokenStudio is Launchpad {
    using SafeERC20 for IERC20;

    /// @notice The most addresses a creation may mint to besides the pool
    uint256 public constant MAX_ALLOCATIONS = 16;

    address public immutable studioTokenImplementation;

    struct Allocation {
        address to;
        uint256 amount;
    }

    struct TokenParams {
        string name;
        string symbol;
        /// @dev paired with the CYBER sent along, in the locked position
        uint256 poolSupply;
        /// @dev minted straight to these addresses, beside the pool
        Allocation[] allocations;
        /// @dev who may mint more; `address(0)` for a fixed supply
        address minter;
        /// @dev the ceiling minting can reach; zero for the token's own cap
        uint256 maxSupply;
        /// @dev hundredths of a bip, at most MAX_CREATOR_FEE
        uint24 creatorFee;
        /// @dev how much of the creator's own fee goes to holders, in basis points
        uint16 holdersShareBps;
        bytes32 salt;
        /// @dev KIT_* flags; KIT_ZONE is not offered here and is ignored
        uint8 kit;
        string metadataURI;
    }

    event Created(
        address indexed token, address indexed minter, uint256 maxSupply, uint256 poolSupply, uint256 allocated
    );

    error BadAllocation();

    constructor(
        address authority,
        IV3Factory dexFactory_,
        IV3PositionManager positions_,
        IWETH9 wcyber_,
        LaunchLocker locker_,
        ILending lending_,
        OracleFactory oracles_,
        LiquidityVaultFactory vaults_,
        uint256 minLiquidity_,
        address studioTokenImplementation_
    ) Launchpad(authority, dexFactory_, positions_, wcyber_, locker_, lending_, oracles_, vaults_, minLiquidity_) {
        studioTokenImplementation = studioTokenImplementation_;
    }

    /// @notice The address a creation by `creator` with `salt` will have
    function predictStudioToken(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(studioTokenImplementation, _salt(creator, salt));
    }

    function create(TokenParams calldata p) external payable returns (address token) {
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert BadMetadata();
        if (p.allocations.length > MAX_ALLOCATIONS) revert BadAllocation();
        if (msg.value < minLiquidity || msg.value == 0) revert NotEnoughCyber();

        uint256 allocated;
        for (uint256 i = 0; i < p.allocations.length; i++) {
            if (p.allocations[i].to == address(0) || p.allocations[i].amount == 0) revert BadAllocation();
            allocated += p.allocations[i].amount;
        }
        uint256 supply = p.poolSupply + allocated;
        if (p.poolSupply == 0 || supply > StudioToken(payable(studioTokenImplementation)).MAX_SUPPLY()) {
            revert BadSupply();
        }

        token = Clones.cloneDeterministic(studioTokenImplementation, _salt(msg.sender, p.salt));
        StudioToken(payable(token)).initialize(p.name, p.symbol, supply, _exclusions(), p.minter, p.maxSupply);

        Economy storage e = _economies[token];
        e.creator = msg.sender;
        e.launchedAt = uint64(block.timestamp);
        e.metadataURI = p.metadataURI;
        allTokens.push(token);

        (uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 protocolBps) =
            quote(p.creatorFee, p.holdersShareBps);

        e.pool = _openPool(token, p.poolSupply, poolFee);
        e.positionId = _lockFullRange(token, e.pool, p.poolSupply, msg.sender, creatorBps, holdersBps);

        // Handed out before the dust is swept: everything the studio still holds after this is the
        // few wei the full-range mint could not take.
        for (uint256 i = 0; i < p.allocations.length; i++) {
            IERC20(token).safeTransfer(p.allocations[i].to, p.allocations[i].amount);
        }
        totalCyberLocked += msg.value - _refundDust(token, msg.sender);

        e.vault = vaults.create(e.pool);
        StudioToken(payable(token)).exclude(e.vault);

        emit Launched(token, msg.sender, e.pool, p.name, p.symbol, supply, msg.value);
        emit LaunchTerms(token, e.positionId, poolFee, creatorBps, holdersBps, protocolBps);
        emit Created(token, p.minter, StudioToken(payable(token)).maxSupply(), p.poolSupply, allocated);

        if (p.kit & KIT_CREDIT != 0 && creditLltv != 0) _openCredit(token, e);
        if (p.kit & KIT_FARM != 0 && address(gauges) != address(0)) _openFarm(token, e);
        if (p.kit & KIT_DAO != 0 && address(daos) != address(0)) _openDao(token, e);
    }
}
