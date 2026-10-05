// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

interface IMindPotWiring {
    function splitter() external view returns (address);
    function factory() external view returns (address);
    function token() external view returns (address);
}

/// @title MindSplitter
/// @notice The fee recipient of one token launched with Agent Minds. Everything Pons credits it (the creator's tax and
///         the 0.7% of each trade the launch factory passes on) is split four ways, in the proportions its creator
///         chose at launch:
///           - the creator's payout wallet
///           - the token's own burn pot, which buys the token and burns it
///           - the $AXON burn pot, which buys $AXON and burns it
///           - the mind's treasury
///         The four shares add up to everything: Axon takes no cut. There is no owner and no function that changes a
///         share or a destination. What a token launches with is what it keeps for as long as this contract exists.
/// @dev One per token, as a minimal proxy of a single implementation; initialize() runs once, in the launch
///      transaction, before the token exists. Pons never pushes fees: the tax sits on the curve, a sweep moves it into
///      Pons' fee escrow, and the escrow credits a ledger. sweep() does both steps and splits; claim() does the escrow
///      half alone; ETH sent straight here is split by distribute(). All three are callable by anyone.
contract MindSplitter {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    /// @dev A payout wallet that misbehaves must not make every split revert: its push gets this much gas and a
    ///      refused push waits for withdrawCreator().
    uint256 internal constant PUSH_GAS = 50_000;

    address payable public payout; // the creator's wallet for their share
    address payable public pot; // the token's own burn pot
    address payable public axonPot; // $AXON's burn pot
    address payable public vault; // the mind's treasury
    IPonsV2FeeEscrow public escrow;

    uint16 public creatorBps;
    uint16 public burnBps;
    uint16 public axonBps;
    uint16 public mindBps;

    uint256 public creatorPending; // a push the payout wallet refused, waiting for withdrawCreator()
    uint256 public totalSplit;
    uint256 public totalToCreator;
    uint256 public totalToBurn;
    uint256 public totalToAxon;
    uint256 public totalToMind;

    uint256 private _lock;

    event Split(uint256 amount, uint256 toCreator, uint256 toBurn, uint256 toAxon, uint256 toMind, bool creatorPushed);
    event SplitToken(address indexed token, uint256 amount, uint256 toCreator, uint256 toBurn);
    event CreatorWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error AlreadySet();
    error BadShares();
    error BadPayout();
    error PotMismatch();
    error PotRejected();
    error NotPayout();
    error Reentered();

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    /// @dev The implementation itself can never be set up: only its proxies are.
    constructor() {
        pot = payable(address(0xdead));
    }

    /// @notice Once, by whoever made this proxy, in the same transaction: the four destinations and their shares.
    function initialize(
        address payable payout_,
        address payable pot_,
        address payable axonPot_,
        address payable vault_,
        IPonsV2FeeEscrow escrow_,
        uint16 creatorBps_,
        uint16 burnBps_,
        uint16 axonBps_,
        uint16 mindBps_
    ) external {
        if (pot != address(0)) revert AlreadySet();
        if (payout_ == address(0) || pot_ == address(0) || axonPot_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        if (address(escrow_) == address(0)) revert ZeroAddress();
        if (uint256(creatorBps_) + burnBps_ + axonBps_ + mindBps_ != BPS) revert BadShares();
        // the payout must be a place of its own: any of these would quietly turn the creator's share into another one
        if (payout_ == pot_ || payout_ == axonPot_ || payout_ == vault_ || payout_ == address(this) || payout_ == address(escrow_)) {
            revert BadPayout();
        }
        if (IMindPotWiring(pot_).splitter() != address(this)) revert PotMismatch();
        payout = payout_;
        pot = pot_;
        axonPot = axonPot_;
        vault = vault_;
        escrow = escrow_;
        creatorBps = creatorBps_;
        burnBps = burnBps_;
        axonBps = axonBps_;
        mindBps = mindBps_;
    }

    receive() external payable {}

    /// @notice Claim what the escrow holds for this splitter and split it.
    function claim() external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Release the curve's fees, claim the escrow, split. Anyone may call it.
    function sweep() external nonReentrant returns (uint256 amount) {
        address c = curve();
        if (c != address(0)) {
            try IPonsV2BondingCurve(c).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice The token's curve while it is still on it, else zero.
    function curve() public view returns (address) {
        try IMindPotWiring(pot).token() returns (address t) {
            if (t == address(0)) return address(0);
            try IPonsV2LaunchFactory(IMindPotWiring(pot).factory()).getLaunchedToken(t) returns (
                IPonsV2LaunchFactory.LaunchedToken memory info
            ) {
                if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
            } catch {}
        } catch {}
        return address(0);
    }

    /// @notice Split whatever ETH is here.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice A token that arrives instead of ETH (these coins are ETH-paired, so this is a safety net): the
    ///         creator's share to the payout wallet, everything else to the burn pot, which burns what it holds.
    function claimToken(IERC20 token) external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOfToken(address(this), address(token)) > 0) escrow.claimToken(address(token));
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        uint256 toCreator = (amount * creatorBps) / BPS;
        uint256 toBurn = amount - toCreator;
        if (toCreator > 0) token.safeTransfer(payout, toCreator);
        if (toBurn > 0) token.safeTransfer(pot, toBurn);
        emit SplitToken(address(token), amount, toCreator, toBurn);
    }

    /// @notice What a refused push left here, to any address the payout wallet names.
    function withdrawCreator(address payable to) external nonReentrant {
        if (msg.sender != payout) revert NotPayout();
        if (to == address(0)) revert ZeroAddress();
        uint256 a = creatorPending;
        creatorPending = 0;
        (bool ok,) = to.call{value: a}("");
        if (!ok) revert PotRejected();
        emit CreatorWithdrawn(to, a);
    }

    function _distribute() internal returns (uint256 amount) {
        amount = address(this).balance - creatorPending;
        if (amount == 0) return 0;
        uint256 toBurn = (amount * burnBps) / BPS;
        uint256 toAxon = (amount * axonBps) / BPS;
        uint256 toMind = (amount * mindBps) / BPS;
        // the remainder, so rounding dust goes to the creator and the four always add up to the whole
        uint256 toCreator = amount - toBurn - toAxon - toMind;

        // $AXON's pot and the mind's treasury take plain ETH; if either ever refused it, that share burns the
        // token instead of freezing every split
        if (toAxon > 0) {
            (bool okAxon,) = axonPot.call{value: toAxon}("");
            if (!okAxon) {
                toBurn += toAxon;
                toAxon = 0;
            }
        }
        if (toMind > 0) {
            (bool okMind,) = vault.call{value: toMind}("");
            if (!okMind) {
                toBurn += toMind;
                toMind = 0;
            }
        }
        if (toBurn > 0) {
            (bool okPot,) = pot.call{value: toBurn}("");
            if (!okPot) revert PotRejected();
        }
        bool pushed = true;
        if (toCreator > 0) {
            (pushed,) = payout.call{value: toCreator, gas: PUSH_GAS}("");
            if (!pushed) creatorPending += toCreator;
        }

        totalSplit += amount;
        totalToCreator += toCreator;
        totalToBurn += toBurn;
        totalToAxon += toAxon;
        totalToMind += toMind;
        emit Split(amount, toCreator, toBurn, toAxon, toMind, pushed);
    }
}
