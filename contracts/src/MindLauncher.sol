// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";
import {MindPot} from "./MindPot.sol";
import {MindSplitter} from "./MindSplitter.sol";
import {MindVault} from "./MindVault.sol";

interface IPotOfATokenLaunchedEarlier {
    function dev() external view returns (address);
    function token() external view returns (address);
}

/// @title MindLauncher
/// @notice Launches a token with Agent Minds, in one transaction: its own burn pot, its own fee splitter and its
///         mind's treasury are made, the token is launched on Pons with the creator's tax, and the creator's opening
///         buy (if any) is made in that same transaction, before anybody else can buy.
///
///         What the creator chooses, once, here, and nobody can change afterwards:
///           - the tax on every trade, 0 to 10% (the launch factory's own ceiling)
///           - where the fees go, four shares that add up to everything: their payout wallet, burning the token,
///             burning $AXON, the mind's treasury
///           - what the mind may do with its treasury, and its limits
///         Axon takes no cut: there is no fifth share and no fee here beyond the launch factory's own.
///
///         It is also the registry every mind's treasury reads: who the signer is (the only key that can start a
///         mind's action, and only inside that treasury's limits), who the guardian is (who can stop a mind, all
///         minds, or new launches, and replace the signer), and where the cost of thinking is paid.
contract MindLauncher {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_TAX_BPS = 1000;
    /// @notice The only launch settings these tokens launch with: the factory's standard.
    uint256 public constant LAUNCH_CONFIG_ID = 0;

    IPonsV2LaunchFactory public immutable ponsFactory;
    IPonsV2FeeEscrow public immutable escrow;
    address payable public immutable axonPot;
    address public immutable splitterImpl;
    address public immutable vaultImpl;
    address public immutable guardian;

    address public signer;
    address payable public costSink;
    bool public mindsPaused;
    bool public launchesPaused;

    struct Coin {
        address creator;
        address pot;
        address splitter;
        address vault;
        address payout;
        uint16 taxBps;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 axonBps;
        uint16 mindBps;
        uint64 launchedAt;
        bytes32 agentRef; // the agent this token stands behind, as Axon names it
    }

    struct LaunchInput {
        string name;
        string symbol;
        string logo;
        string description;
        IPonsV2LaunchFactory.Socials socials;
        bytes32 salt;
        bytes32 agentRef;
        uint16 taxBps;
        address payable payout;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 axonBps;
        uint16 mindBps;
        MindVault.Limits limits;
    }

    mapping(address => Coin) public coins; // by token
    mapping(address => address) public vaultOf; // by token, also for tokens that got their mind later
    address[] public tokens;
    uint256 private _made; // proxies made, for their salts
    uint256 private _lock;

    event Launched(
        address indexed token,
        address indexed creator,
        bytes32 indexed agentRef,
        address pot,
        address splitter,
        address vault,
        address payout,
        uint16 taxBps,
        uint16 creatorBps,
        uint16 burnBps,
        uint16 axonBps,
        uint16 mindBps
    );
    event MindAttached(address indexed token, address indexed creator, address pot, address vault);
    event SignerSet(address indexed signer);
    event CostSinkSet(address indexed costSink);
    event MindsPaused(bool paused);
    event LaunchesPaused(bool paused);

    error ZeroAddress();
    error NotGuardian();
    error LaunchesArePaused();
    error TaxTooHigh(uint16 bps, uint16 max);
    error BadShares();
    error WiringMismatch();
    error NotThatTokensCreator();
    error NoToken();
    error HasMind();
    error Reentered();

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(IPonsV2LaunchFactory ponsFactory_, address payable axonPot_, address guardian_, address signer_, address payable costSink_) {
        if (address(ponsFactory_) == address(0) || axonPot_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (signer_ == address(0) || costSink_ == address(0)) revert ZeroAddress();
        address escrow_ = ponsFactory_.feeEscrow();
        if (escrow_ == address(0)) revert ZeroAddress();
        ponsFactory = ponsFactory_;
        escrow = IPonsV2FeeEscrow(escrow_);
        axonPot = axonPot_;
        guardian = guardian_;
        signer = signer_;
        costSink = costSink_;
        splitterImpl = address(new MindSplitter());
        vaultImpl = address(new MindVault());
    }

    // ---------- launching ----------

    /// @notice Launch a token with its mind. msg.value is the launch factory's fee plus the creator's optional
    ///         opening buy, of whatever size they choose; the tokens it buys go straight to the creator, and what
    ///         they bought is on the chain for anybody to see.
    function launch(LaunchInput calldata in_) external payable nonReentrant returns (address token) {
        if (launchesPaused) revert LaunchesArePaused();
        if (in_.payout == address(0)) revert ZeroAddress();
        if (in_.taxBps > MAX_TAX_BPS) revert TaxTooHigh(in_.taxBps, MAX_TAX_BPS);
        if (uint256(in_.creatorBps) + in_.burnBps + in_.axonBps + in_.mindBps != BPS) revert BadShares();

        (MindPot pot, MindSplitter splitter, MindVault vault) = _make(in_.taxBps);
        _wire(splitter, pot, vault, in_);
        token = _launchOnPons(pot, in_);
        vault.initialize(token, payable(address(pot)), axonPot, msg.sender, in_.limits);
        if (pot.splitter() != address(splitter) || splitter.pot() != address(pot) || splitter.vault() != address(vault)) revert WiringMismatch();
        _record(token, in_, address(pot), address(splitter), address(vault));
    }

    /// @dev The pot has to know its splitter before the splitter exists, so the splitter's address is worked out first.
    function _make(uint16 taxBps) internal returns (MindPot pot, MindSplitter splitter, MindVault vault) {
        bytes32 salt = bytes32(++_made);
        address splitterAt = Clones.predictDeterministicAddress(splitterImpl, salt, address(this));
        pot = new MindPot(address(this), ponsFactory, splitterAt, taxBps);
        vault = MindVault(payable(Clones.cloneDeterministic(vaultImpl, salt)));
        splitter = MindSplitter(payable(Clones.cloneDeterministic(splitterImpl, salt)));
        if (address(splitter) != splitterAt) revert WiringMismatch();
    }

    function _wire(MindSplitter splitter, MindPot pot, MindVault vault, LaunchInput calldata in_) internal {
        splitter.initialize(
            in_.payout, payable(address(pot)), axonPot, payable(address(vault)), escrow, in_.creatorBps, in_.burnBps, in_.axonBps, in_.mindBps
        );
    }

    function _launchOnPons(MindPot pot, LaunchInput calldata in_) internal returns (address token) {
        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = in_.name;
        p.symbol = in_.symbol;
        p.logo = in_.logo;
        p.description = in_.description;
        p.socials = in_.socials;
        p.salt = in_.salt;
        // the creator, and nobody else, is spared the launch seconds' tax; their opening buy lands with them
        address[] memory exempt = new address[](1);
        exempt[0] = msg.sender;
        token = pot.launch{value: msg.value}(p, LAUNCH_CONFIG_ID, exempt);
    }

    function _record(address token, LaunchInput calldata in_, address pot, address splitter, address vault) internal {
        Coin memory c = Coin({
            creator: msg.sender,
            pot: pot,
            splitter: splitter,
            vault: vault,
            payout: in_.payout,
            taxBps: in_.taxBps,
            creatorBps: in_.creatorBps,
            burnBps: in_.burnBps,
            axonBps: in_.axonBps,
            mindBps: in_.mindBps,
            launchedAt: uint64(block.timestamp),
            agentRef: in_.agentRef
        });
        coins[token] = c;
        vaultOf[token] = vault;
        tokens.push(token);
        emit Launched(token, c.creator, c.agentRef, c.pot, c.splitter, c.vault, c.payout, c.taxBps, c.creatorBps, c.burnBps, c.axonBps, c.mindBps);
    }

    /// @notice A mind for an agent token launched before Agent Minds. Only the wallet that launched it can do this.
    ///         That token's fees keep going where they always went (its split cannot be changed); this treasury is
    ///         filled by whoever tops it up, and its buybacks go to that token's own burn pot.
    function attachMind(address pot, MindVault.Limits calldata limits) external nonReentrant returns (address vault) {
        if (IPotOfATokenLaunchedEarlier(pot).dev() != msg.sender) revert NotThatTokensCreator();
        address token = IPotOfATokenLaunchedEarlier(pot).token();
        if (token == address(0)) revert NoToken();
        if (vaultOf[token] != address(0)) revert HasMind();
        // only a pot the launch factory itself recorded as that token's launcher counts
        IPonsV2LaunchFactory.LaunchedToken memory info = ponsFactory.getLaunchedToken(token);
        if (!info.exists || info.deployer != pot) revert NoToken();
        vault = Clones.cloneDeterministic(vaultImpl, bytes32(++_made));
        MindVault(payable(vault)).initialize(token, payable(pot), axonPot, msg.sender, limits);
        vaultOf[token] = vault;
        emit MindAttached(token, msg.sender, pot, vault);
    }

    /// @notice A token's record, whole.
    function coin(address token) external view returns (Coin memory) {
        return coins[token];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ---------- the guardian ----------

    function setSigner(address signer_) external onlyGuardian {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }

    function setCostSink(address payable costSink_) external onlyGuardian {
        if (costSink_ == address(0)) revert ZeroAddress();
        costSink = costSink_;
        emit CostSinkSet(costSink_);
    }

    /// @notice Stop, or let go on, every mind at once. Claims of rewards already open go on.
    function setMindsPaused(bool paused) external onlyGuardian {
        mindsPaused = paused;
        emit MindsPaused(paused);
    }

    function setLaunchesPaused(bool paused) external onlyGuardian {
        launchesPaused = paused;
        emit LaunchesPaused(paused);
    }
}
