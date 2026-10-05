// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest, ICurveX, Rejecter} from "./Fork.sol";
import {AgentLaunchFactory} from "../src/AgentLaunchFactory.sol";
import {AgentSplitter} from "../src/AgentSplitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {MindLauncher} from "../src/MindLauncher.sol";
import {MindPot} from "../src/MindPot.sol";
import {MindSplitter} from "../src/MindSplitter.sol";
import {MindVault} from "../src/MindVault.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// Agent Minds against the real Pons, on a fork of Robinhood Chain: the launch, the fee split, the mind's treasury,
/// and everything somebody might try that must not work.
contract MindsForkTest is ForkTest {
    // $AXON's own burn pot, live on the chain
    address payable constant AXON_POT = payable(0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MindLauncher launcher;
    address guardian = address(0x6A2D);
    address signer = address(0x5161);
    address payable costSink = payable(address(0xC057));
    address payable creator = payable(address(0xC2EA));
    address payable payout = payable(address(0xFA1D));
    address trader = address(0x72AD);
    address stranger = address(0x5727);

    function setUp() public {
        _fork();
        launcher = new MindLauncher(IPonsV2LaunchFactory(FACTORY), AXON_POT, guardian, signer, costSink);
    }

    // ---------- helpers ----------

    function _limits() internal pure returns (MindVault.Limits memory l) {
        l.allowed = 7;
        l.maxPerDay = 1 ether;
        l.maxPerAction = 0.5 ether;
        l.maxActionsPerDay = 6;
        l.maxCostPerDay = 0.002 ether;
    }

    function _in(uint16 tax, uint16 c, uint16 b, uint16 a, uint16 m, bytes32 salt) internal view returns (MindLauncher.LaunchInput memory i) {
        i.name = "Research Agent";
        i.symbol = "RSRCH";
        i.logo = "ipfs://logo";
        i.description = "A token backed by an agent that works.";
        i.socials.twitter = "https://x.com/example";
        i.salt = salt;
        i.agentRef = keccak256("research-agent");
        i.taxBps = tax;
        i.payout = payout;
        i.creatorBps = c;
        i.burnBps = b;
        i.axonBps = a;
        i.mindBps = m;
        i.limits = _limits();
    }

    function _launch(MindLauncher.LaunchInput memory i, uint256 openingBuy) internal returns (address token) {
        uint256 fee = _pons().launchFee();
        vm.deal(creator, creator.balance + fee + openingBuy);
        vm.prank(creator);
        token = launcher.launch{value: fee + openingBuy}(i);
    }

    function _coin(address token) internal view returns (MindLauncher.Coin memory) {
        return launcher.coin(token);
    }

    /// Past the launch seconds' tax, then somebody trades.
    function _trade(address token, uint256 eth) internal {
        vm.warp(block.timestamp + 10 minutes);
        address curve = _pons().getLaunchedToken(token).curve;
        vm.deal(trader, trader.balance + eth);
        vm.prank(trader);
        ICurveX(curve).buy{value: eth}(eth, 0, trader);
    }

    function _vault(address token) internal view returns (MindVault) {
        return MindVault(payable(launcher.vaultOf(token)));
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory out) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok, "balanceOf");
        return abi.decode(out, (uint256));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    // ---------- the launch ----------

    function test_fork_oneTransactionLaunchesTheTokenItsPotItsSplitterAndItsMind() public {
        address token = _launch(_in(500, 4000, 3000, 1000, 2000, keccak256("one")), 0.05 ether);
        MindLauncher.Coin memory c = _coin(token);

        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        assertTrue(info.exists, "Pons has the token");
        assertEq(info.deployer, c.pot, "its pot is the recorded launcher");
        assertEq(info.creatorFeeRecipient, c.splitter, "fees are aimed at its own splitter");
        assertEq(info.creatorTaxBps, 500, "the creator's tax, not a fixed one");
        assertFalse(info.buybackEnabled);
        assertEq(info.pairToken, address(0), "paired with ETH");

        assertEq(c.creator, creator);
        assertEq(c.payout, payout);
        assertEq(c.agentRef, keccak256("research-agent"));
        assertEq(MindPot(payable(c.pot)).CREATOR_TAX_BPS(), 500);
        assertEq(address(MindPot(payable(c.pot)).token()), token);

        MindSplitter s = MindSplitter(payable(c.splitter));
        assertEq(s.payout(), payout);
        assertEq(s.pot(), c.pot);
        assertEq(s.axonPot(), AXON_POT);
        assertEq(s.vault(), c.vault);
        assertEq(uint256(s.creatorBps()) + s.burnBps() + s.axonBps() + s.mindBps(), 10_000);

        MindVault v = MindVault(payable(c.vault));
        assertEq(v.token(), token);
        assertEq(v.creator(), creator);
        assertEq(v.pot(), c.pot);
        (uint8 allowed, uint96 perDay,,,) = v.limits();
        assertEq(allowed, 7);
        assertEq(perDay, 1 ether);

        assertGt(_balanceOf(token, creator), 0, "the opening buy landed with the creator");
        assertEq(_balanceOf(token, c.pot), 0, "the pot holds none of the token");
        assertEq(address(launcher).balance, 0, "the launcher keeps nothing");
        assertEq(launcher.tokenCount(), 1);
    }

    function test_fork_theTaxIsTheCreatorsFromZeroToTenPercent() public {
        address zero = _launch(_in(0, 10_000, 0, 0, 0, keccak256("tax0")), 0);
        assertEq(_pons().getLaunchedToken(zero).creatorTaxBps, 0);
        address ten = _launch(_in(1000, 2500, 2500, 2500, 2500, keccak256("tax10")), 0);
        assertEq(_pons().getLaunchedToken(ten).creatorTaxBps, 1000);

        MindLauncher.LaunchInput memory over = _in(1001, 2500, 2500, 2500, 2500, keccak256("tax11"));
        uint256 fee = _pons().launchFee();
        vm.deal(creator, fee);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MindLauncher.TaxTooHigh.selector, uint16(1001), uint16(1000)));
        launcher.launch{value: fee}(over);
    }

    function test_fork_sharesMustAddUpAndThePayoutMustExist() public {
        uint256 fee = _pons().launchFee();
        vm.deal(creator, 3 * fee);
        MindLauncher.LaunchInput memory short_ = _in(300, 4000, 3000, 1000, 1999, keccak256("short"));
        vm.prank(creator);
        vm.expectRevert(MindLauncher.BadShares.selector);
        launcher.launch{value: fee}(short_);

        MindLauncher.LaunchInput memory nobody = _in(300, 4000, 3000, 1000, 2000, keccak256("nobody"));
        nobody.payout = payable(address(0));
        vm.prank(creator);
        vm.expectRevert(MindLauncher.ZeroAddress.selector);
        launcher.launch{value: fee}(nobody);
    }

    function test_fork_theOpeningBuyIsCapped() public {
        uint256 fee = _pons().launchFee();
        vm.deal(creator, fee + 1 ether);
        MindLauncher.LaunchInput memory i = _in(300, 4000, 3000, 1000, 2000, keccak256("whale"));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MindLauncher.OpeningBuyTooLarge.selector, 1 ether, launcher.MAX_OPENING_BUY()));
        launcher.launch{value: fee + 1 ether}(i);
    }

    function test_fork_launchesCanBePausedByTheGuardianOnly() public {
        vm.prank(stranger);
        vm.expectRevert(MindLauncher.NotGuardian.selector);
        launcher.setLaunchesPaused(true);
        vm.prank(guardian);
        launcher.setLaunchesPaused(true);
        uint256 fee = _pons().launchFee();
        vm.deal(creator, fee);
        MindLauncher.LaunchInput memory i = _in(300, 4000, 3000, 1000, 2000, keccak256("paused"));
        vm.prank(creator);
        vm.expectRevert(MindLauncher.LaunchesArePaused.selector);
        launcher.launch{value: fee}(i);
    }

    // ---------- the fee split ----------

    function test_fork_feesSplitFourWaysAndAxonKeepsNothing() public {
        address token = _launch(_in(500, 4000, 3000, 1000, 2000, keccak256("split")), 0);
        MindLauncher.Coin memory c = _coin(token);
        _trade(token, 1 ether);

        uint256 pay0 = payout.balance;
        uint256 pot0 = c.pot.balance;
        uint256 axon0 = AXON_POT.balance;
        uint256 vault0 = c.vault.balance;
        uint256 sink0 = costSink.balance;
        uint256 guard0 = guardian.balance;

        uint256 amount = MindSplitter(payable(c.splitter)).sweep();
        assertGt(amount, 0, "the trade left fees to split");

        uint256 toCreator = payout.balance - pay0;
        uint256 toBurn = c.pot.balance - pot0;
        uint256 toAxon = AXON_POT.balance - axon0;
        uint256 toMind = c.vault.balance - vault0;
        assertEq(toCreator + toBurn + toAxon + toMind, amount, "the four shares are all of it");
        assertEq(toBurn, (amount * 3000) / 10_000);
        assertEq(toAxon, (amount * 1000) / 10_000);
        assertEq(toMind, (amount * 2000) / 10_000);
        assertApproxEqAbs(toCreator, (amount * 4000) / 10_000, 3, "the creator's share, with the rounding dust");
        assertEq(c.splitter.balance, 0, "nothing stays in the splitter");
        assertEq(address(launcher).balance, 0, "nothing reaches the launcher");
        assertEq(costSink.balance, sink0, "nothing reaches Axon's wallet");
        assertEq(guardian.balance, guard0, "nothing reaches the guardian");
    }

    function test_fork_aTokenCanSendEverythingToOnePlace() public {
        address allCreator = _launch(_in(300, 10_000, 0, 0, 0, keccak256("all-creator")), 0);
        MindLauncher.Coin memory c = _coin(allCreator);
        _trade(allCreator, 0.5 ether);
        uint256 pay0 = payout.balance;
        uint256 amount = MindSplitter(payable(c.splitter)).sweep();
        assertEq(payout.balance - pay0, amount);

        address allBurn = _launch(_in(300, 0, 10_000, 0, 0, keccak256("all-burn")), 0);
        MindLauncher.Coin memory d = _coin(allBurn);
        _trade(allBurn, 0.5 ether);
        uint256 pot0 = d.pot.balance;
        amount = MindSplitter(payable(d.splitter)).sweep();
        assertEq(d.pot.balance - pot0, amount);
    }

    function test_fork_aPayoutWalletThatRefusesEthDoesNotFreezeTheSplit() public {
        MindLauncher.LaunchInput memory i = _in(500, 4000, 3000, 1000, 2000, keccak256("rejecter"));
        Rejecter r = new Rejecter();
        i.payout = payable(address(r));
        address token = _launch(i, 0);
        MindLauncher.Coin memory c = _coin(token);
        _trade(token, 1 ether);
        MindSplitter s = MindSplitter(payable(c.splitter));
        uint256 amount = s.sweep();
        assertGt(s.creatorPending(), 0, "the creator's share waits");
        assertEq(c.pot.balance, (amount * 3000) / 10_000, "the burn share still went");
        // and only the payout wallet can take what waits
        vm.prank(stranger);
        vm.expectRevert(MindSplitter.NotPayout.selector);
        s.withdrawCreator(payable(stranger));
        uint256 pending = s.creatorPending();
        vm.prank(address(r));
        s.withdrawCreator(payable(stranger));
        assertEq(stranger.balance, pending);
    }

    function test_fork_nothingCanBeSetUpTwice() public {
        address token = _launch(_in(500, 4000, 3000, 1000, 2000, keccak256("twice")), 0);
        MindLauncher.Coin memory c = _coin(token);
        vm.prank(stranger);
        vm.expectRevert(MindSplitter.AlreadySet.selector);
        MindSplitter(payable(c.splitter)).initialize(payable(stranger), payable(c.pot), AXON_POT, payable(c.vault), IPonsV2FeeEscrow(ESCROW), 10_000, 0, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(MindVault.AlreadySet.selector);
        MindVault(payable(c.vault)).initialize(token, payable(c.pot), AXON_POT, stranger, _limits());
        // nor the implementations themselves
        MindSplitter splitterImpl = MindSplitter(payable(launcher.splitterImpl()));
        MindVault vaultImpl = MindVault(payable(launcher.vaultImpl()));
        vm.expectRevert(MindSplitter.AlreadySet.selector);
        splitterImpl.initialize(payable(stranger), payable(c.pot), AXON_POT, payable(c.vault), IPonsV2FeeEscrow(ESCROW), 10_000, 0, 0, 0);
        vm.expectRevert(MindVault.AlreadySet.selector);
        vaultImpl.initialize(token, payable(c.pot), AXON_POT, stranger, _limits());
    }

    // ---------- the mind's treasury ----------

    function _funded(bytes32 salt, uint256 eth) internal returns (address token, MindVault v, MindLauncher.Coin memory c) {
        token = _launch(_in(500, 4000, 3000, 1000, 2000, salt), 0);
        c = _coin(token);
        v = MindVault(payable(c.vault));
        vm.deal(address(v), eth);
    }

    function test_fork_onlyTheSignerStartsAnythingAndNobodyWithdraws() public {
        (, MindVault v,) = _funded(keccak256("signer"), 1 ether);
        address[4] memory others = [creator, guardian, stranger, costSink];
        for (uint256 k; k < others.length; ++k) {
            vm.startPrank(others[k]);
            vm.expectRevert(MindVault.NotSigner.selector);
            v.buyback(0.1 ether);
            vm.expectRevert(MindVault.NotSigner.selector);
            v.burnAxon(0.1 ether);
            vm.expectRevert(MindVault.NotSigner.selector);
            v.startReward(keccak256("root"), 0.1 ether);
            vm.expectRevert(MindVault.NotSigner.selector);
            v.payThinking(0.001 ether);
            vm.stopPrank();
        }
        assertEq(address(v).balance, 1 ether, "the treasury is whole");
    }

    function test_fork_aBuybackGoesToThePotAndThePotBurnsTheToken() public {
        (address token, MindVault v, MindLauncher.Coin memory c) = _funded(keccak256("buyback"), 1 ether);
        _trade(token, 0.5 ether);
        uint256 pot0 = c.pot.balance;
        vm.prank(signer);
        v.buyback(0.2 ether);
        assertEq(c.pot.balance - pot0, 0.2 ether);
        assertEq(v.totalBuyback(), 0.2 ether);

        vm.warp(block.timestamp + 31 minutes);
        uint256 dead0 = _balanceOf(token, DEAD);
        MindPot(payable(c.pot)).burn(0);
        assertGt(_balanceOf(token, DEAD), dead0, "the token was bought and burned");
        assertGt(MindPot(payable(c.pot)).totalTokensBurned(), 0);
    }

    function test_fork_aBuybackStillBurnsAfterGraduation() public {
        (address token, MindVault v, MindLauncher.Coin memory c) = _funded(keccak256("graduated"), 1 ether);
        vm.warp(block.timestamp + 10 minutes);
        _graduate(token, _pons().getLaunchedToken(token).curve, trader);
        vm.prank(signer);
        v.buyback(0.3 ether);
        vm.warp(block.timestamp + 31 minutes);
        uint256 dead0 = _balanceOf(token, DEAD);
        MindPot(payable(c.pot)).burn(0);
        assertGt(_balanceOf(token, DEAD), dead0, "burned through the pool");
    }

    function test_fork_burnAxonGoesToAxonsPot() public {
        (, MindVault v,) = _funded(keccak256("axon"), 1 ether);
        uint256 axon0 = AXON_POT.balance;
        vm.prank(signer);
        v.burnAxon(0.25 ether);
        assertEq(AXON_POT.balance - axon0, 0.25 ether);
        assertEq(v.totalAxon(), 0.25 ether);
    }

    function test_fork_theLimitsItsCreatorSetAreEnforcedOnChain() public {
        (, MindVault v,) = _funded(keccak256("limits"), 5 ether);
        vm.startPrank(signer);
        vm.expectRevert(abi.encodeWithSelector(MindVault.OverAction.selector, 0.6 ether, 0.5 ether));
        v.buyback(0.6 ether);
        v.buyback(0.5 ether);
        v.buyback(0.4 ether);
        vm.expectRevert(abi.encodeWithSelector(MindVault.OverDay.selector, 1.1 ether, 1 ether));
        v.buyback(0.2 ether);
        v.buyback(0.02 ether);
        v.buyback(0.02 ether);
        v.buyback(0.02 ether);
        v.buyback(0.02 ether);
        // six actions today: the seventh is refused whatever its size
        vm.expectRevert(abi.encodeWithSelector(MindVault.TooManyActions.selector, uint256(6)));
        v.buyback(0.001 ether);
        // a new day, a new allowance
        vm.warp(block.timestamp + 1 days);
        v.buyback(0.5 ether);
        vm.stopPrank();
    }

    function test_fork_aMindOnlyDoesWhatItsCreatorAllowed() public {
        MindLauncher.LaunchInput memory i = _in(500, 4000, 3000, 1000, 2000, keccak256("only-buyback"));
        i.limits.allowed = 1; // buybacks only
        address token = _launch(i, 0);
        MindVault v = _vault(token);
        vm.deal(address(v), 1 ether);
        vm.startPrank(signer);
        v.buyback(0.1 ether);
        vm.expectRevert(MindVault.NotAllowed.selector);
        v.burnAxon(0.1 ether);
        vm.expectRevert(MindVault.NotAllowed.selector);
        v.startReward(keccak256("root"), 0.1 ether);
        vm.stopPrank();
    }

    function test_fork_limitsPastTheCeilingsAreRefusedAtLaunch() public {
        uint256 fee = _pons().launchFee();
        vm.deal(creator, 3 * fee);
        MindLauncher.LaunchInput memory i = _in(500, 4000, 3000, 1000, 2000, keccak256("ceil-a"));
        i.limits.maxActionsPerDay = 25;
        vm.prank(creator);
        vm.expectRevert(MindVault.BadLimits.selector);
        launcher.launch{value: fee}(i);
        i = _in(500, 4000, 3000, 1000, 2000, keccak256("ceil-b"));
        i.limits.maxCostPerDay = 0.02 ether;
        vm.prank(creator);
        vm.expectRevert(MindVault.BadLimits.selector);
        launcher.launch{value: fee}(i);
        i = _in(500, 4000, 3000, 1000, 2000, keccak256("ceil-c"));
        i.limits.allowed = 8;
        vm.prank(creator);
        vm.expectRevert(MindVault.BadLimits.selector);
        launcher.launch{value: fee}(i);
    }

    function test_fork_thinkingIsPaidToTheCostSinkUnderItsOwnCeiling() public {
        (, MindVault v,) = _funded(keccak256("thinking"), 1 ether);
        uint256 sink0 = costSink.balance;
        vm.startPrank(signer);
        v.payThinking(0.0015 ether);
        assertEq(costSink.balance - sink0, 0.0015 ether);
        vm.expectRevert(abi.encodeWithSelector(MindVault.OverCost.selector, 0.0025 ether, 0.002 ether));
        v.payThinking(0.001 ether);
        v.payThinking(0.0005 ether);
        vm.warp(block.timestamp + 1 days);
        v.payThinking(0.002 ether);
        vm.stopPrank();
        assertEq(v.totalThinking(), 0.004 ether);
    }

    function test_fork_aMindCanBeStoppedByItsCreatorTheGuardianOrAllAtOnce() public {
        (, MindVault v,) = _funded(keccak256("stop"), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(MindVault.NotCreator.selector);
        v.setPaused(true);
        vm.prank(creator);
        v.setPaused(true);
        vm.prank(signer);
        vm.expectRevert(MindVault.Inactive.selector);
        v.buyback(0.1 ether);
        vm.prank(creator);
        v.setPaused(false);

        vm.prank(creator);
        vm.expectRevert(MindVault.NotGuardian.selector);
        v.setFrozen(true);
        vm.prank(guardian);
        v.setFrozen(true);
        vm.startPrank(signer);
        vm.expectRevert(MindVault.Inactive.selector);
        v.buyback(0.1 ether);
        vm.expectRevert(MindVault.Inactive.selector);
        v.payThinking(0.001 ether);
        vm.stopPrank();
        vm.prank(guardian);
        v.setFrozen(false);

        vm.prank(guardian);
        launcher.setMindsPaused(true);
        vm.prank(signer);
        vm.expectRevert(MindVault.Inactive.selector);
        v.buyback(0.1 ether);
        vm.prank(guardian);
        launcher.setMindsPaused(false);
        vm.prank(signer);
        v.buyback(0.1 ether);
    }

    function test_fork_aStolenSignerIsReplacedInOnePlace() public {
        (, MindVault v,) = _funded(keccak256("rotate"), 1 ether);
        address fresh = address(0xF2E5);
        vm.prank(stranger);
        vm.expectRevert(MindLauncher.NotGuardian.selector);
        launcher.setSigner(fresh);
        vm.prank(guardian);
        launcher.setSigner(fresh);
        vm.prank(signer);
        vm.expectRevert(MindVault.NotSigner.selector);
        v.buyback(0.1 ether);
        vm.prank(fresh);
        v.buyback(0.1 ether);
    }

    // ---------- rewards ----------

    // four holders and their parts, as a tree
    address payable[4] internal H = [payable(address(0xA001)), payable(address(0xA002)), payable(address(0xA003)), payable(address(0xA004))];
    uint256[4] internal PART = [uint256(0.1 ether), 0.1 ether, 0.05 ether, 0.05 ether];

    function _l(uint256 i) internal view returns (bytes32) {
        return _leaf(i, H[i], PART[i]);
    }

    function _root() internal view returns (bytes32) {
        return _pair(_pair(_l(0), _l(1)), _pair(_l(2), _l(3)));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = _l(i ^ 1);
        p[1] = i < 2 ? _pair(_l(2), _l(3)) : _pair(_l(0), _l(1));
    }

    function test_fork_holdersClaimTheirPartAfterTheWaitAndOnlyOnce() public {
        (, MindVault v,) = _funded(keccak256("reward"), 1 ether);
        vm.prank(signer);
        uint256 id = v.startReward(_root(), 0.3 ether);
        assertEq(v.reserved(), 0.3 ether);
        assertEq(v.available(), 0.7 ether, "what is promised cannot be spent again");

        vm.expectRevert(MindVault.NotOpen.selector);
        v.claim(id, 0, H[0], PART[0], _proof(0));

        vm.warp(block.timestamp + 31 minutes);
        v.claim(id, 0, H[0], PART[0], _proof(0));
        assertEq(H[0].balance, 0.1 ether);
        vm.expectRevert(MindVault.AlreadyClaimed.selector);
        v.claim(id, 0, H[0], PART[0], _proof(0));

        // a bigger amount, another wallet, or another index does not pass the proof
        vm.expectRevert(MindVault.BadProof.selector);
        v.claim(id, 2, H[2], 0.3 ether, _proof(2));
        vm.expectRevert(MindVault.BadProof.selector);
        v.claim(id, 2, payable(stranger), PART[2], _proof(2));
        vm.expectRevert(MindVault.BadProof.selector);
        v.claim(id, 3, H[2], PART[2], _proof(2));
        v.claim(id, 2, H[2], PART[2], _proof(2));
        assertEq(H[2].balance, 0.05 ether);
        assertEq(v.reserved(), 0.15 ether);

        // what nobody claims comes back to the treasury after the window, not before
        vm.expectRevert(MindVault.NotOpen.selector);
        v.closeReward(id);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(MindVault.TooLate.selector);
        v.claim(id, 1, H[1], PART[1], _proof(1));
        v.closeReward(id);
        assertEq(v.reserved(), 0);
        assertEq(v.available(), 0.85 ether);
        vm.expectRevert(MindVault.Closed.selector);
        v.closeReward(id);
    }

    function test_fork_aRewardCanBeStruckWhileItWaits() public {
        (, MindVault v,) = _funded(keccak256("strike"), 1 ether);
        address payable h0 = payable(address(0xA001));
        bytes32 root = _pair(_leaf(0, h0, 0.2 ether), _leaf(1, stranger, 0.1 ether));
        vm.prank(signer);
        uint256 id = v.startReward(root, 0.3 ether);
        vm.prank(stranger);
        vm.expectRevert(MindVault.NotCreator.selector);
        v.strike(id);
        vm.prank(creator);
        v.strike(id);
        assertEq(v.reserved(), 0, "the ETH is the treasury's again");
        assertEq(v.totalRewarded(), 0);
        vm.warp(block.timestamp + 31 minutes);
        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(1, stranger, 0.1 ether);
        vm.expectRevert(MindVault.Closed.selector);
        v.claim(id, 0, h0, 0.2 ether, p);

        // and once claims are open it is too late to strike
        vm.prank(signer);
        id = v.startReward(root, 0.3 ether);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(guardian);
        vm.expectRevert(MindVault.TooLate.selector);
        v.strike(id);
    }

    function test_fork_aMindCannotPromiseOrSpendWhatItDoesNotHave() public {
        (, MindVault v,) = _funded(keccak256("broke"), 0.3 ether);
        vm.startPrank(signer);
        v.startReward(keccak256("root"), 0.25 ether);
        vm.expectRevert(abi.encodeWithSelector(MindVault.NotEnough.selector, 0.1 ether, 0.05 ether));
        v.buyback(0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(MindVault.NotEnough.selector, 0.1 ether, 0.05 ether));
        v.startReward(keccak256("root2"), 0.1 ether);
        vm.stopPrank();
    }

    // ---------- a mind for a token launched earlier ----------

    function test_fork_onlyAnEarlierTokensOwnCreatorCanGiveItAMind() public {
        AgentLaunchFactory old = new AgentLaunchFactory(IPonsV2LaunchFactory(FACTORY));
        address payable dev = payable(address(0xA9E47));
        (BurnPot pot,) = old.deployPair(dev, 7000);
        uint256 fee = _pons().launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        address token = pot.launch{value: fee}(_params(keccak256("earlier")), 0, _noExempt());

        vm.prank(stranger);
        vm.expectRevert(MindLauncher.NotThatTokensCreator.selector);
        launcher.attachMind(address(pot), _limits());

        vm.prank(dev);
        address vault = launcher.attachMind(address(pot), _limits());
        assertEq(launcher.vaultOf(token), vault);
        MindVault v = MindVault(payable(vault));
        assertEq(v.creator(), dev);
        assertEq(v.pot(), address(pot));

        vm.prank(dev);
        vm.expectRevert(MindLauncher.HasMind.selector);
        launcher.attachMind(address(pot), _limits());

        // its buybacks reach that token's own pot
        vm.deal(vault, 1 ether);
        uint256 pot0 = address(pot).balance;
        vm.prank(signer);
        v.buyback(0.2 ether);
        assertEq(address(pot).balance - pot0, 0.2 ether);
    }

    function test_fork_aPotNobodyLaunchedThroughGetsNoMind() public {
        AgentLaunchFactory old = new AgentLaunchFactory(IPonsV2LaunchFactory(FACTORY));
        (BurnPot pot,) = old.deployPair(payable(stranger), 7000);
        vm.prank(stranger);
        vm.expectRevert(MindLauncher.NoToken.selector);
        launcher.attachMind(address(pot), _limits());
    }
}
