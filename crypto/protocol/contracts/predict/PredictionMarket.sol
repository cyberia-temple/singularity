// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Prediction markets in any currency, settled without trusting anyone in particular
/// @notice Anyone opens a market: a question, two to eight outcomes, a close time, and the currency
/// it is bet in -- CYBER or any token, a launched token included. Bets go into one pool per outcome;
/// winners split the losing pools pro rata to their stake, less the protocol's and the creator's fee.
///
/// How the answer is decided is chosen when the market is opened, and shown with it:
///
///  - **Optimistic** -- after close anyone may propose the answer by posting a bond of `bondBps` of
///    the pot. If nobody disputes it within `liveness`, it stands and the bond comes back. A dispute
///    posts the same bond and sends the question to the arbiter, and whoever the arbiter agrees with
///    takes both bonds. Lying costs a bond; catching a lie pays one.
///  - **Operator** -- the protocol's own resolver answers (machine-checkable questions: prices,
///    on-chain facts).
///  - **Creator** -- the creator answers. For communities that trust their creator, and labelled so.
///
/// Whatever the mode, a market nobody answers within `RESOLVE_WINDOW` of closing refunds every
/// stake, and resolving it becomes impossible -- money is never stuck behind an absent resolver.
contract PredictionMarket is AccessManaged, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    address public constant NATIVE = address(0);
    uint8 public constant INVALID = type(uint8).max;
    uint8 public constant MAX_OUTCOMES = 8;
    uint256 public constant RESOLVE_WINDOW = 30 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_QUESTION_LENGTH = 400;
    uint16 public constant MAX_CREATOR_FEE_BPS = 500;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 500;

    enum Mode {
        Optimistic,
        Operator,
        Creator
    }

    enum State {
        Open,
        Proposed,
        Disputed,
        Resolved
    }

    struct Market {
        address creator;
        address asset;
        uint64 closeTime;
        uint64 resolvedAt;
        uint8 outcomes;
        uint8 result;
        Mode mode;
        State state;
        uint16 creatorFeeBps;
        uint16 protocolFeeBps;
        uint256 totalStaked;
        uint256 fees;
        address proposer;
        uint8 proposed;
        uint64 proposedAt;
        address disputer;
        uint256 bond;
        string question;
    }

    Market[] internal _markets;
    mapping(uint256 id => mapping(uint8 outcome => uint256)) public outcomePool;
    mapping(uint256 id => mapping(address user => mapping(uint8 outcome => uint256))) public stakeOf;
    mapping(uint256 id => mapping(address user => bool)) public claimed;

    /// @notice Bonds and fees waiting to be withdrawn, per asset and account
    mapping(address asset => mapping(address account => uint256)) public owed;

    uint16 public protocolFeeBps = 200;
    uint16 public bondBps = 500;
    uint64 public liveness = 1 days;
    address public feeRecipient;
    /// @notice An anti-spam fee in CYBER for opening a market; the operator opens for free
    uint256 public createFee;

    event MarketCreated(
        uint256 indexed id, address indexed creator, address asset, uint8 outcomes, uint64 closeTime, Mode mode, string question
    );
    event BetPlaced(uint256 indexed id, address indexed user, uint8 outcome, uint256 amount);
    event Proposed(uint256 indexed id, address indexed proposer, uint8 outcome, uint256 bond);
    event Disputed(uint256 indexed id, address indexed disputer);
    event Resolved(uint256 indexed id, uint8 result, uint256 fees);
    event Claimed(uint256 indexed id, address indexed user, uint256 amount);
    event SettingsChanged();

    error BadQuestion();
    error BadOutcome();
    error BadTime();
    error BadFee();
    error WrongPayment();
    error NoSuchMarket();
    error BettingClosed();
    error NotClosed();
    error WrongMode();
    error WrongState();
    error NotCreator();
    error LivenessRunning();
    error LivenessOver();
    error WindowLapsed();
    error NothingToClaim();
    error TransferFailed();

    constructor(address authority, address feeRecipient_, uint256 createFee_) AccessManaged(authority) {
        feeRecipient = feeRecipient_;
        createFee = createFee_;
    }

    // -------------------------------------------------------------------------------- create

    /// @notice Open an optimistic or a creator-resolved market, for `createFee` in CYBER
    /// @param asset NATIVE for CYBER, or any ERC-20
    function createMarket(
        string calldata question,
        uint8 outcomes,
        address asset,
        uint64 closeTime,
        Mode mode,
        uint16 creatorFeeBps
    ) external payable returns (uint256 id) {
        if (mode == Mode.Operator) revert WrongMode();
        if (msg.value != createFee) revert WrongPayment();
        if (createFee > 0) _sendNative(feeRecipient, createFee);
        id = _create(question, outcomes, asset, closeTime, mode, creatorFeeBps);
    }

    /// @notice Open a market the protocol's resolver will answer
    function createOperatorMarket(string calldata question, uint8 outcomes, address asset, uint64 closeTime)
        external
        restricted
        returns (uint256 id)
    {
        id = _create(question, outcomes, asset, closeTime, Mode.Operator, 0);
    }

    function _create(
        string calldata question,
        uint8 outcomes,
        address asset,
        uint64 closeTime,
        Mode mode,
        uint16 creatorFeeBps
    ) internal returns (uint256 id) {
        uint256 len = bytes(question).length;
        if (len == 0 || len > MAX_QUESTION_LENGTH) revert BadQuestion();
        if (outcomes < 2 || outcomes > MAX_OUTCOMES) revert BadOutcome();
        if (closeTime <= block.timestamp || closeTime > block.timestamp + MAX_DURATION) revert BadTime();
        if (creatorFeeBps > MAX_CREATOR_FEE_BPS) revert BadFee();

        id = _markets.length;
        Market storage m = _markets.push();
        m.creator = msg.sender;
        m.asset = asset;
        m.closeTime = closeTime;
        m.outcomes = outcomes;
        m.mode = mode;
        m.creatorFeeBps = creatorFeeBps;
        m.protocolFeeBps = protocolFeeBps;
        m.question = question;

        emit MarketCreated(id, msg.sender, asset, outcomes, closeTime, mode, question);
    }

    // ----------------------------------------------------------------------------------- bet

    function bet(uint256 id, uint8 outcome, uint256 amount) external payable nonReentrant {
        Market storage m = _market(id);
        if (block.timestamp >= m.closeTime || m.state != State.Open) revert BettingClosed();
        if (outcome >= m.outcomes) revert BadOutcome();
        if (amount == 0) revert WrongPayment();
        _pull(m.asset, amount);

        outcomePool[id][outcome] += amount;
        stakeOf[id][msg.sender][outcome] += amount;
        m.totalStaked += amount;

        emit BetPlaced(id, msg.sender, outcome, amount);
    }

    // ----------------------------------------------------------------------------- resolution

    /// @notice Optimistic mode: propose the answer, with a bond of `bondBps` of the pot
    function propose(uint256 id, uint8 outcome) external payable nonReentrant {
        Market storage m = _closedAndLive(id);
        if (m.mode != Mode.Optimistic) revert WrongMode();
        if (m.state != State.Open) revert WrongState();
        _checkOutcome(m, outcome);

        uint256 bond = m.totalStaked * bondBps / BPS;
        _pull(m.asset, bond);

        m.state = State.Proposed;
        m.proposer = msg.sender;
        m.proposed = outcome;
        m.proposedAt = uint64(block.timestamp);
        m.bond = bond;

        emit Proposed(id, msg.sender, outcome, bond);
    }

    /// @notice Optimistic mode: challenge a proposal within `liveness`, matching its bond
    function dispute(uint256 id) external payable nonReentrant {
        Market storage m = _closedAndLive(id);
        if (m.state != State.Proposed) revert WrongState();
        if (block.timestamp >= m.proposedAt + liveness) revert LivenessOver();

        _pull(m.asset, m.bond);
        m.state = State.Disputed;
        m.disputer = msg.sender;

        emit Disputed(id, msg.sender);
    }

    /// @notice Optimistic mode: an undisputed proposal stands once `liveness` has passed
    function finalize(uint256 id) external nonReentrant {
        Market storage m = _closedAndLive(id);
        if (m.state != State.Proposed) revert WrongState();
        if (block.timestamp < m.proposedAt + liveness) revert LivenessRunning();

        _resolve(id, m, m.proposed);
        _credit(m.asset, m.proposer, m.bond);
    }

    /// @notice Settle a disputed proposal; whoever was right takes both bonds
    function arbitrate(uint256 id, uint8 outcome) external restricted nonReentrant {
        Market storage m = _closedAndLive(id);
        if (m.state != State.Disputed) revert WrongState();
        _checkOutcome(m, outcome);

        _resolve(id, m, outcome);
        _credit(m.asset, outcome == m.proposed ? m.proposer : m.disputer, m.bond * 2);
    }

    /// @notice Operator mode: the protocol's resolver answers
    function resolveByOperator(uint256 id, uint8 outcome) external restricted nonReentrant {
        Market storage m = outcome == INVALID ? _live(id) : _closedAndLive(id);
        if (m.mode != Mode.Operator) revert WrongMode();
        if (m.state != State.Open) revert WrongState();
        _checkOutcome(m, outcome);
        _resolve(id, m, outcome);
    }

    /// @notice Creator mode: the creator answers
    function resolveByCreator(uint256 id, uint8 outcome) external nonReentrant {
        Market storage m = outcome == INVALID ? _live(id) : _closedAndLive(id);
        if (m.mode != Mode.Creator) revert WrongMode();
        if (msg.sender != m.creator) revert NotCreator();
        if (m.state != State.Open) revert WrongState();
        _checkOutcome(m, outcome);
        _resolve(id, m, outcome);
    }

    // --------------------------------------------------------------------------------- claims

    /// @notice Collect winnings, or a refund: of a cancelled market, of one nobody won, or of one
    /// nobody answered in time
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Market storage m = _market(id);
        if (claimed[id][msg.sender]) revert NothingToClaim();
        amount = _payoutOf(id, m, msg.sender);
        if (amount == 0) revert NothingToClaim();

        claimed[id][msg.sender] = true;
        _send(m.asset, msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice Return the bonds of a proposal or dispute nobody settled before the window closed;
    /// the stakes of such a market are refunded through `claim`
    function reclaimBonds(uint256 id) external nonReentrant {
        Market storage m = _market(id);
        if (block.timestamp <= uint256(m.closeTime) + RESOLVE_WINDOW) revert WrongState();
        if (m.state != State.Proposed && m.state != State.Disputed) revert WrongState();

        uint256 bond = m.bond;
        m.bond = 0;
        _credit(m.asset, m.proposer, bond);
        if (m.state == State.Disputed) _credit(m.asset, m.disputer, bond);
        m.state = State.Open;
    }

    /// @notice Take bonds and fees credited to you
    function withdraw(address asset) external nonReentrant returns (uint256 amount) {
        amount = owed[asset][msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[asset][msg.sender] = 0;
        _send(asset, msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------- views

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 id) external view returns (Market memory) {
        return _market(id);
    }

    function pools(uint256 id) external view returns (uint256[] memory amounts) {
        Market storage m = _market(id);
        amounts = new uint256[](m.outcomes);
        for (uint8 i = 0; i < m.outcomes; i++) {
            amounts[i] = outcomePool[id][i];
        }
    }

    function claimable(uint256 id, address user) external view returns (uint256) {
        if (claimed[id][user]) return 0;
        return _payoutOf(id, _market(id), user);
    }

    // ----------------------------------------------------------------------------- governance

    function setSettings(uint16 protocolFeeBps_, uint16 bondBps_, uint64 liveness_, address feeRecipient_, uint256 createFee_)
        external
        restricted
    {
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS || bondBps_ > BPS || liveness_ == 0) revert BadFee();
        protocolFeeBps = protocolFeeBps_;
        bondBps = bondBps_;
        liveness = liveness_;
        feeRecipient = feeRecipient_;
        createFee = createFee_;
        emit SettingsChanged();
    }

    // ------------------------------------------------------------------------------ internals

    function _market(uint256 id) internal view returns (Market storage) {
        if (id >= _markets.length) revert NoSuchMarket();
        return _markets[id];
    }

    /// @dev Past close and still inside the window in which an answer may be given.
    function _closedAndLive(uint256 id) internal view returns (Market storage m) {
        m = _market(id);
        if (block.timestamp < m.closeTime) revert NotClosed();
        if (block.timestamp > uint256(m.closeTime) + RESOLVE_WINDOW) revert WindowLapsed();
    }

    /// @dev Still inside the window in which an answer may be given (closed or not).
    function _live(uint256 id) internal view returns (Market storage m) {
        m = _market(id);
        if (block.timestamp > uint256(m.closeTime) + RESOLVE_WINDOW) revert WindowLapsed();
    }

    function _credit(address asset, address account, uint256 amount) internal {
        if (amount > 0) owed[asset][account] += amount;
    }

    function _checkOutcome(Market storage m, uint8 outcome) internal view {
        if (outcome >= m.outcomes && outcome != INVALID) revert BadOutcome();
    }

    function _resolve(uint256 id, Market storage m, uint8 result) internal {
        m.state = State.Resolved;
        m.result = result;
        m.resolvedAt = uint64(block.timestamp);

        if (result != INVALID) {
            uint256 winPool = outcomePool[id][result];
            uint256 losers = m.totalStaked - winPool;
            if (winPool > 0 && losers > 0) {
                uint256 protocolFee = losers * m.protocolFeeBps / BPS;
                uint256 creatorFee = losers * m.creatorFeeBps / BPS;
                m.fees = protocolFee + creatorFee;
                _credit(m.asset, feeRecipient, protocolFee);
                _credit(m.asset, m.creator, creatorFee);
            }
        }
        emit Resolved(id, result, m.fees);
    }

    function _payoutOf(uint256 id, Market storage m, address user) internal view returns (uint256) {
        bool lapsed = m.state != State.Resolved && block.timestamp > uint256(m.closeTime) + RESOLVE_WINDOW;
        bool refund = lapsed || (m.state == State.Resolved && (m.result == INVALID || outcomePool[id][m.result] == 0));

        if (refund) {
            uint256 total;
            for (uint8 i = 0; i < m.outcomes; i++) {
                total += stakeOf[id][user][i];
            }
            return total;
        }
        if (m.state != State.Resolved) return 0;

        uint256 stake = stakeOf[id][user][m.result];
        if (stake == 0) return 0;
        uint256 winPool = outcomePool[id][m.result];
        return stake + stake * (m.totalStaked - winPool - m.fees) / winPool;
    }

    function _pull(address asset, uint256 amount) internal {
        if (asset == NATIVE) {
            if (msg.value != amount) revert WrongPayment();
        } else {
            if (msg.value != 0) revert WrongPayment();
            if (amount > 0) IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _send(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == NATIVE) _sendNative(to, amount);
        else IERC20(asset).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
