// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MindLauncher} from "../src/MindLauncher.sol";
import {MindSplitter} from "../src/MindSplitter.sol";
import {MindVault} from "../src/MindVault.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

interface IAxonPot {
    function token() external view returns (address);
    function totalTokensBurned() external view returns (uint256);
}

/// Deploys Agent Minds: the MindLauncher, which makes the splitter's and the treasury's implementations itself.
///
///   GUARDIAN=0x… SIGNER=0x… COST_SINK=0x… forge script script/DeployMinds.s.sol \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --interactive --sender <the admin wallet>
///
/// GUARDIAN stops minds and launches and replaces the signer; SIGNER is the bot key that sends what the rule check
/// approved; COST_SINK is the wallet the cost of thinking is paid to. Forge asks for the deployer's key at its prompt.
contract DeployMinds is Script {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    /// $AXON's own burn pot and $AXON itself, live on Robinhood Chain.
    address payable constant AXON_POT = payable(0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9);
    address constant AXON = 0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2;

    function run() external returns (MindLauncher launcher) {
        require(block.chainid == 4663, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
        address guardian = vm.envAddress("GUARDIAN");
        address signer = vm.envAddress("SIGNER");
        address payable costSink = payable(vm.envAddress("COST_SINK"));
        require(guardian != address(0) && signer != address(0) && costSink != address(0), "GUARDIAN, SIGNER and COST_SINK");
        // the signer's key lives on a server; the guardian's power is to stop it: they must not be one key
        require(signer != guardian, "SIGNER must be a key of its own");
        require(PONS.code.length > 0, "no contract at the Pons address on this chain");
        require(IAxonPot(AXON_POT).token() == AXON, "that is not $AXON's burn pot");

        console.log("Guardian:  %s", guardian);
        console.log("Signer:    %s", signer);
        console.log("Cost sink: %s", costSink);

        vm.startBroadcast();
        launcher = new MindLauncher(IPonsV2LaunchFactory(PONS), AXON_POT, guardian, signer, costSink);
        vm.stopBroadcast();

        _verify(launcher, guardian, signer, costSink);
        console.log("");
        console.log("MIND_LAUNCHER=%s", address(launcher));
    }

    /// forge script script/DeployMinds.s.sol --sig "check(address)" <launcher> --rpc-url $RPC_URL
    function check(address addr) external view {
        require(addr.code.length > 0, "no contract at that address");
        MindLauncher launcher = MindLauncher(addr);
        _verify(launcher, launcher.guardian(), launcher.signer(), launcher.costSink());
        console.log("OK: MindLauncher %s", addr);
        console.log("    guardian  %s", launcher.guardian());
        console.log("    signer    %s", launcher.signer());
        console.log("    cost sink %s", launcher.costSink());
        console.log("    tokens launched so far: %s", launcher.tokenCount());
    }

    function _verify(MindLauncher launcher, address guardian, address signer, address costSink) internal view {
        require(address(launcher.ponsFactory()) == PONS, "launcher points at the wrong Pons");
        require(address(launcher.escrow()) == IPonsV2LaunchFactory(PONS).feeEscrow(), "escrow drifted from Pons");
        require(launcher.axonPot() == AXON_POT, "launcher points at the wrong $AXON pot");
        require(launcher.guardian() == guardian && launcher.signer() == signer && launcher.costSink() == costSink, "wrong wallets");
        require(!launcher.mindsPaused() && !launcher.launchesPaused(), "born paused");
        // the implementations can never be set up themselves
        require(MindSplitter(payable(launcher.splitterImpl())).pot() != address(0), "splitter implementation is open");
        require(address(MindVault(payable(launcher.vaultImpl())).registry()) != address(0), "vault implementation is open");
    }
}
