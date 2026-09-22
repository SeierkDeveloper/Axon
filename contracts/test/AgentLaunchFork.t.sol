// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest} from "./Fork.sol";
import {AgentLaunchFactory} from "../src/AgentLaunchFactory.sol";
import {AgentSplitter} from "../src/AgentSplitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

interface ILauncherTokenX {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
}

/// The factory path, against the real Pons on Robinhood Chain.
///
/// Everything else about this feature is tested against a mock: a small contract that answers the four
/// calls BurnPot's constructor makes. That proves the wiring and proves nothing about Pons. The first time
/// a factory-deployed pot meets the actual launchpad is the moment somebody presses the button, and a
/// launch cannot be taken back.
///
/// So it happens here first, on a fork of the live chain, where the pot calls the real factory at its real
/// address with its real state. Nothing is broadcast, nothing costs anything, and no token exists
/// afterwards, which is the point: proving it works should not require making one.
contract AgentLaunchForkTest is ForkTest {
    AgentLaunchFactory factory;
    address payable dev = payable(address(0xA9E47));

    function setUp() public {
        _fork();
        factory = new AgentLaunchFactory(IPonsV2LaunchFactory(FACTORY));
    }

    function test_fork_factoryReadsTheRealPons() public view {
        assertEq(address(factory.ponsFactory()), FACTORY, "points at the live Pons");
        assertEq(address(factory.escrow()), ESCROW, "escrow matches what Pons reports");
    }

    function test_fork_deployedPairLaunchesOnTheRealPons() public {
        (BurnPot pot, AgentSplitter splitter) = factory.deployPair(dev, 7000);

        uint256 fee = _pons().launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        address token = pot.launch{value: fee}(_params(keccak256("agent-fork")), 0, _noExempt());

        // What Pons itself recorded, not what we hoped it would.
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        assertTrue(info.exists, "Pons has the token");
        assertEq(info.deployer, address(pot), "the pot is the recorded deployer");
        assertEq(info.creatorFeeRecipient, address(splitter), "fees are aimed at this agent's splitter");
        assertEq(info.creatorTaxBps, 300, "the pot forces the tax rather than trusting the caller");
        assertFalse(info.buybackEnabled);
        assertEq(ILauncherTokenX(token).symbol(), "TOKEN");
        assertEq(ILauncherTokenX(token).totalSupply(), 1_000_000_000 ether);
    }

    /// The split is the thing each agent chooses, so it is the thing most worth checking survives a real
    /// launch rather than only a mock one.
    function test_fork_theChosenSplitIsWhatPonsPaysInto() public {
        (BurnPot potA, AgentSplitter splitterA) = factory.deployPair(dev, 7000);
        (BurnPot potB, AgentSplitter splitterB) = factory.deployPair(payable(address(0xB0B)), 2500);

        assertEq(splitterA.DEV_BPS(), 7000);
        assertEq(splitterB.DEV_BPS(), 2500);

        uint256 fee = _pons().launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        address tokenA = potA.launch{value: fee}(_params(keccak256("split-a")), 0, _noExempt());

        vm.deal(address(0xB0B), fee);
        vm.prank(address(0xB0B));
        address tokenB = potB.launch{value: fee}(_params(keccak256("split-b")), 0, _noExempt());

        // Two agents, two tokens, two fee recipients. Neither can reach the other's money.
        assertEq(_pons().getLaunchedToken(tokenA).creatorFeeRecipient, address(splitterA));
        assertEq(_pons().getLaunchedToken(tokenB).creatorFeeRecipient, address(splitterB));
        assertTrue(tokenA != tokenB);
    }

    /// msg.value above the launch fee buys on the curve in the same transaction, and those tokens go to
    /// the first exemption entry. Somebody launching with a dev buy is the common case, so it is the case
    /// most worth proving against the real curve rather than a stub of one.
    function test_fork_devBuyLandsWithTheAgentsWallet() public {
        (BurnPot pot,) = factory.deployPair(dev, 7000);

        uint256 fee = _pons().launchFee();
        uint256 devBuy = 0.05 ether;
        vm.deal(dev, fee + devBuy);
        vm.prank(dev);
        address token = pot.launch{value: fee + devBuy}(_params(keccak256("devbuy")), 0, _exempt(dev));

        assertGt(_balanceOf(token, dev), 0, "the dev holds tokens from its own first buy");
        assertEq(_balanceOf(token, address(pot)), 0, "the pot never holds the token it will later buy");
    }

    /// The bytes the launch page actually builds, fired at the real Pons.
    ///
    /// Every other test here builds the params in Solidity, which is the one language guaranteed to agree
    /// with the contract. The browser does not: it describes the same struct a second time, by hand, in an
    /// ABI string. That description was wrong. It flattened Socials into five loose strings, left out
    /// expectedEconomics, and put salt in the middle, and none of that shows up as an error anywhere. viem
    /// encodes it, the button works, the wallet asks for a signature, and the launch reverts after the user
    /// has approved it.
    ///
    /// So this does not rebuild the params. It reads the calldata the page produces, written by
    /// scripts/gen-launch-calldata.ts out of the same module the browser imports, and sends those bytes
    /// unaltered to a pot the factory deployed, on a fork of the live chain. If the shape is wrong the raw
    /// call fails, which is what should have happened the first time rather than in somebody's wallet.
    function test_fork_thePagesOwnCalldataLaunchesOnTheRealPons() public {
        bytes memory data = vm.parseBytes(vm.trim(vm.readFile("test/fixtures/launchCalldata.txt")));

        // The fixture names this dev, because snipeExempt[0] is baked into those bytes.
        address payable fixtureDev = payable(0x000000000000000000000000000000000000A9e4);
        (BurnPot pot, AgentSplitter splitter) = factory.deployPair(fixtureDev, 7000);

        uint256 fee = _pons().launchFee();
        vm.deal(fixtureDev, fee);
        vm.prank(fixtureDev);
        (bool ok, bytes memory out) = address(pot).call{value: fee}(data);
        assertTrue(ok, "the calldata the page builds is not what the pot accepts");

        address token = abi.decode(out, (address));
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        assertTrue(info.exists, "Pons launched from the page's own bytes");
        assertEq(info.deployer, address(pot));
        assertEq(info.creatorFeeRecipient, address(splitter), "the pot still overrode the recipient");
        assertEq(info.creatorTaxBps, 300);

        // The metadata in the fixture survived the trip, which is what proves the fields line up rather
        // than merely that the call did not revert: a struct off by one field can still decode to
        // something, it just decodes to the wrong thing.
        assertEq(ILauncherTokenX(token).name(), "Fixture Agent");
        assertEq(ILauncherTokenX(token).symbol(), "FIXT");
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory out) =
            token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && out.length >= 32 ? abi.decode(out, (uint256)) : 0;
    }
}
