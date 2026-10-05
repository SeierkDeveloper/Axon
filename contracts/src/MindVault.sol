// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IMindRegistry {
    function signer() external view returns (address);
    function guardian() external view returns (address);
    function costSink() external view returns (address payable);
    function mindsPaused() external view returns (bool);
}

/// @title MindVault
/// @notice The treasury of one token's mind. ETH comes in from the token's fee splitter (and from anyone who tops it
///         up) and can leave in exactly four ways, each of them started by the minds' signer after the rule check and
///         each bounded here again, on chain:
///           - buyback: to the token's own burn pot, which buys the token and burns it
///           - burnAxon: to $AXON's burn pot, which buys $AXON and burns it
///           - reward: shared among the token's holders, who claim their part against a published list
///           - thinking: what the mind's own thinking cost, to the cost sink, under its own daily ceiling
///         There is no withdraw function: not for the creator, not for Axon, not for the signer. The mind chooses a
///         kind and an amount; the limits its creator set at launch decide whether that may happen, and nothing here
///         lets anyone change those limits afterwards.
/// @dev One per token, as a minimal proxy; initialize() runs once in the launch transaction. The signer, the guardian
///      and the cost sink are read from the registry (the MindLauncher), so a stolen signer key is replaced in one
///      place. A reward waits WAIT before it can be claimed; in that time the creator or the guardian can strike it
///      and the ETH stays in the treasury.
contract MindVault {
    uint8 public constant CAN_BUYBACK = 1;
    uint8 public constant CAN_REWARD = 2;
    uint8 public constant CAN_BURN_AXON = 4;
    /// @notice Ceilings no creator can set past.
    uint16 public constant MAX_ACTIONS_PER_DAY = 24;
    uint96 public constant MAX_COST_PER_DAY = 0.01 ether;
    /// @notice How long a reward waits before holders can claim it, and how long they then have.
    uint256 public constant WAIT = 30 minutes;
    uint256 public constant CLAIM_WINDOW = 30 days;

    struct Limits {
        uint8 allowed; // CAN_* bits
        uint96 maxPerDay; // ETH the mind may send out in a day (buybacks, $AXON burns and rewards together)
        uint96 maxPerAction; // and in one action
        uint16 maxActionsPerDay;
        uint96 maxCostPerDay; // what its thinking may cost in a day
    }

    struct Reward {
        bytes32 root;
        uint96 total;
        uint96 claimed;
        uint64 startAt; // claims open
        uint64 endAt; // claims close
        bool struck;
        bool closed;
    }

    IMindRegistry public registry;
    address public token;
    address payable public pot;
    address payable public axonPot;
    address public creator;
    Limits public limits;

    bool public paused; // by its creator
    bool public frozen; // by the guardian
    uint256 public reserved; // ETH promised to rewards not yet claimed or closed
    Reward[] public rewards;
    mapping(uint256 => mapping(uint256 => uint256)) private _claimedBits;

    mapping(uint256 => uint256) public spentOn; // day => ETH sent out by actions
    mapping(uint256 => uint256) public actionsOn; // day => actions started
    mapping(uint256 => uint256) public costOn; // day => thinking paid

    uint256 public totalBuyback;
    uint256 public totalAxon;
    uint256 public totalRewarded; // started and not struck
    uint256 public totalClaimed;
    uint256 public totalThinking;

    uint256 private _lock;

    event Buyback(uint256 amount);
    event AxonBurn(uint256 amount);
    event RewardStarted(uint256 indexed id, bytes32 root, uint256 total, uint256 startAt, uint256 endAt);
    event RewardStruck(uint256 indexed id, address indexed by);
    event RewardClosed(uint256 indexed id, uint256 unclaimed);
    event Claimed(uint256 indexed id, address indexed account, uint256 amount);
    event ThinkingPaid(uint256 amount);
    event Paused(bool paused);
    event Frozen(bool frozen);

    error AlreadySet();
    error ZeroAddress();
    error BadLimits();
    error NotSigner();
    error NotCreator();
    error NotGuardian();
    error NotAllowed();
    error Inactive();
    error OverAction(uint256 amount, uint256 max);
    error OverDay(uint256 wouldBe, uint256 max);
    error TooManyActions(uint256 max);
    error OverCost(uint256 wouldBe, uint256 max);
    error NotEnough(uint256 amount, uint256 available);
    error ZeroAmount();
    error BadReward();
    error TooLate();
    error NotOpen();
    error Closed();
    error AlreadyClaimed();
    error BadProof();
    error OverReward();
    error SendFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlySigner() {
        if (msg.sender != registry.signer()) revert NotSigner();
        _;
    }

    /// @dev The implementation itself can never be set up: only its proxies are.
    constructor() {
        registry = IMindRegistry(address(0xdead));
    }

    /// @notice Once, by the registry that made this proxy, in the same transaction.
    function initialize(address token_, address payable pot_, address payable axonPot_, address creator_, Limits calldata l) external {
        if (address(registry) != address(0)) revert AlreadySet();
        if (token_ == address(0) || pot_ == address(0) || axonPot_ == address(0) || creator_ == address(0)) revert ZeroAddress();
        if (l.maxActionsPerDay > MAX_ACTIONS_PER_DAY || l.maxCostPerDay > MAX_COST_PER_DAY || l.maxPerAction > l.maxPerDay) revert BadLimits();
        if (l.allowed > (CAN_BUYBACK | CAN_REWARD | CAN_BURN_AXON)) revert BadLimits();
        registry = IMindRegistry(msg.sender);
        token = token_;
        pot = pot_;
        axonPot = axonPot_;
        creator = creator_;
        limits = l;
    }

    receive() external payable {}

    // ---------- views ----------

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice What the mind can still spend: everything here that is not promised to a reward.
    function available() public view returns (uint256) {
        return address(this).balance - reserved;
    }

    /// @notice Whether the mind may act right now.
    function active() public view returns (bool) {
        return !paused && !frozen && !registry.mindsPaused();
    }

    function rewardCount() external view returns (uint256) {
        return rewards.length;
    }

    function isClaimed(uint256 id, uint256 index) public view returns (bool) {
        return (_claimedBits[id][index >> 8] >> (index & 0xff)) & 1 == 1;
    }

    // ---------- what the mind may do ----------

    /// @notice Send ETH to the token's own burn pot. The pot buys the token and burns it on its own schedule.
    function buyback(uint256 amount) external onlySigner nonReentrant {
        _spend(CAN_BUYBACK, amount);
        totalBuyback += amount;
        (bool ok,) = pot.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Buyback(amount);
    }

    /// @notice Send ETH to $AXON's burn pot.
    function burnAxon(uint256 amount) external onlySigner nonReentrant {
        _spend(CAN_BURN_AXON, amount);
        totalAxon += amount;
        (bool ok,) = axonPot.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit AxonBurn(amount);
    }

    /// @notice Set ETH aside for the token's holders. `root` is the Merkle root of (index, account, amount) leaves,
    ///         built off chain from the token's holders at one block; the amounts must add up to `total`. Claims open
    ///         after WAIT and close CLAIM_WINDOW later.
    function startReward(bytes32 root, uint256 total) external onlySigner nonReentrant returns (uint256 id) {
        if (root == bytes32(0)) revert BadReward();
        _spend(CAN_REWARD, total);
        reserved += total;
        totalRewarded += total;
        id = rewards.length;
        uint64 startAt = uint64(block.timestamp + WAIT);
        uint64 endAt = uint64(block.timestamp + WAIT + CLAIM_WINDOW);
        rewards.push(Reward({root: root, total: uint96(total), claimed: 0, startAt: startAt, endAt: endAt, struck: false, closed: false}));
        emit RewardStarted(id, root, total, startAt, endAt);
    }

    /// @notice Pay for the mind's own thinking, at cost, under its daily ceiling. Not an action: it has its own limit.
    function payThinking(uint256 amount) external onlySigner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (frozen || registry.mindsPaused()) revert Inactive();
        uint256 day = today();
        uint256 wouldBe = costOn[day] + amount;
        if (wouldBe > limits.maxCostPerDay) revert OverCost(wouldBe, limits.maxCostPerDay);
        if (amount > available()) revert NotEnough(amount, available());
        costOn[day] = wouldBe;
        totalThinking += amount;
        (bool ok,) = registry.costSink().call{value: amount}("");
        if (!ok) revert SendFailed();
        emit ThinkingPaid(amount);
    }

    // ---------- holders ----------

    /// @notice A holder's part of a reward. Anyone may send the claim; the ETH goes to `account`.
    function claim(uint256 id, uint256 index, address payable account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Reward storage r = rewards[id];
        if (r.struck || r.closed) revert Closed();
        if (block.timestamp < r.startAt) revert NotOpen();
        if (block.timestamp >= r.endAt) revert TooLate();
        if (isClaimed(id, index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, r.root, leaf)) revert BadProof();
        if (uint256(r.claimed) + amount > r.total) revert OverReward();
        _claimedBits[id][index >> 8] |= (1 << (index & 0xff));
        r.claimed += uint96(amount);
        reserved -= amount;
        totalClaimed += amount;
        (bool ok,) = account.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Claimed(id, account, amount);
    }

    /// @notice After a reward's window: what nobody claimed goes back to the treasury. Anyone may call it.
    function closeReward(uint256 id) external nonReentrant {
        Reward storage r = rewards[id];
        if (r.struck || r.closed) revert Closed();
        if (block.timestamp < r.endAt) revert NotOpen();
        r.closed = true;
        uint256 unclaimed = uint256(r.total) - r.claimed;
        reserved -= unclaimed;
        emit RewardClosed(id, unclaimed);
    }

    // ---------- stopping it ----------

    /// @notice The creator or the guardian stops a reward while it waits. Its ETH stays in the treasury.
    function strike(uint256 id) external nonReentrant {
        if (msg.sender != creator && msg.sender != registry.guardian()) revert NotCreator();
        Reward storage r = rewards[id];
        if (r.struck || r.closed) revert Closed();
        if (block.timestamp >= r.startAt) revert TooLate();
        r.struck = true;
        reserved -= r.total;
        totalRewarded -= r.total;
        emit RewardStruck(id, msg.sender);
    }

    /// @notice The creator pauses or resumes their own mind. Nothing leaves while it is paused; claims go on.
    function setPaused(bool paused_) external {
        if (msg.sender != creator) revert NotCreator();
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice The guardian freezes or unfreezes this mind.
    function setFrozen(bool frozen_) external {
        if (msg.sender != registry.guardian()) revert NotGuardian();
        frozen = frozen_;
        emit Frozen(frozen_);
    }

    // ---------- internals ----------

    function _spend(uint8 kind, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (!active()) revert Inactive();
        Limits memory l = limits;
        if (l.allowed & kind == 0) revert NotAllowed();
        if (amount > l.maxPerAction) revert OverAction(amount, l.maxPerAction);
        uint256 day = today();
        if (actionsOn[day] + 1 > l.maxActionsPerDay) revert TooManyActions(l.maxActionsPerDay);
        uint256 wouldBe = spentOn[day] + amount;
        if (wouldBe > l.maxPerDay) revert OverDay(wouldBe, l.maxPerDay);
        if (amount > available()) revert NotEnough(amount, available());
        actionsOn[day] += 1;
        spentOn[day] = wouldBe;
    }
}
