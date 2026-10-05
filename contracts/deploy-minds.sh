#!/bin/zsh
# Deploys Agent Minds (the MindLauncher) on Robinhood Chain, from the main wallet.
#
#   contracts/deploy-minds.sh
#
# One thing is asked for: the main wallet's private key, typed or pasted at forge's own prompt (nothing shows).
# The three wallets are written below and shown before anything is sent:
#   guardian  = the main wallet: stops minds and launches, replaces the gas wallet. FIXED FOR GOOD by this deploy.
#   gas       = the wallet whose key is on the server as MIND_SIGNER_KEY: sends what the rule check approved.
#   costs     = where minds pay back what their thinking cost.
#
# Each step prints a line as it starts:
#   1/4 the chain and the wallets      3/4 the deploy (the key)
#   2/4 a dry run, with what it costs  4/4 everything read back from the chain
# Nothing is sent before step 3, and a failed step stops the script.
export PATH="$HOME/.foundry/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); cd $HERE
LIVE=https://rpc.mainnet.chain.robinhood.com
RPC=${MINDS_RPC:-$LIVE}
MAIN=${MINDS_MAIN:-0xdCC2F8B89c86Fd700850fD542850f06121b7a9e3}
GAS=0xaCb092822eB443cacc68399f78fE17899aA4ecdC
COSTS=0x3b52e87f505234ba4a877c8bb5d896180534a51f
RUN=$HERE/broadcast/DeployMinds.s.sol/4663/run-latest.json
TMP=$(mktemp -t minds-deploy); trap 'rm -f $TMP $TMP.mark; rm -rf $HERE/foundry-pp' EXIT
step() { echo; echo "== $1"; }
die() { echo; echo "STOPPED: $1"; exit 1; }
eth() { python3 -c "print(f'{int(\"$1\")/10**18:.6f}')"; }
# a rehearsal on a local copy of the chain may pass a throwaway key; the real chain never takes one from here
if [ -n "$MINDS_TEST_KEY" ]; then
  case "$RPC" in http://127.0.0.1:*|http://localhost:*) ;; *) die "a key is only taken from the environment for a local rehearsal";; esac
  SIGN=(--private-key $MINDS_TEST_KEY)
else
  SIGN=(--interactive)
fi

step "1/4 the chain and the wallets"
CHAIN=$(cast chain-id --rpc-url $RPC 2>/dev/null) || die "the node at $RPC did not answer"
[ "$CHAIN" = 4663 ] || die "this is chain $CHAIN, not Robinhood Chain (4663)"
BAL=$(cast balance $MAIN --rpc-url $RPC)
[ "$(cast code $GAS --rpc-url $RPC)" = "0x" ] || die "the gas wallet $GAS is a contract, not a wallet"
echo "  main wallet (deploys, and becomes the guardian for good)  $MAIN  holds $(eth $BAL) ETH"
echo "  gas wallet (its key is MIND_SIGNER_KEY on the server)     $GAS  holds $(eth $(cast balance $GAS --rpc-url $RPC)) ETH"
echo "  costs wallet (minds pay their thinking back to it)        $COSTS"

step "2/4 a dry run: the whole deploy against the chain as it is now, nothing sent"
GUARDIAN=$MAIN SIGNER=$GAS COST_SINK=$COSTS forge script script/DeployMinds.s.sol --rpc-url $RPC --sender $MAIN > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
GASUSED=$(grep "Estimated total gas used for script" $TMP | awk '{print $NF}')
NEED=$(grep "Estimated amount required" $TMP | awk '{print $(NF-1)}')
[ -n "$GASUSED" ] && [ -n "$NEED" ] || { tail -15 $TMP; die "the dry run gave no estimate, so nothing was sent"; }
echo "  one transaction, about $GASUSED gas, at most $NEED ETH"
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int(float('$NEED')*10**18) else 1)" || die "the main wallet holds $(eth $BAL) ETH and the deploy needs up to $NEED ETH. Nothing was sent."

step "3/4 the deploy: forge now asks for the main wallet's private key (nothing shows as it is typed or pasted)"
touch $TMP.mark
GUARDIAN=$MAIN SIGNER=$GAS COST_SINK=$COSTS forge script script/DeployMinds.s.sol --rpc-url $RPC --broadcast $SIGN --sender $MAIN \
  || die "the deploy did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."
[ $RUN -nt $TMP.mark ] || die "forge wrote no record of the deploy ($RUN)"
LAUNCHER=$(python3 -c "import json; d=json.load(open('$RUN')); print([t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='MindLauncher'][0])")
BLOCK=$(python3 -c "import json; d=json.load(open('$RUN')); print(int(d['receipts'][0]['blockNumber'],16))")
SPENT=$(python3 -c "import json; d=json.load(open('$RUN')); print(sum(int(r['gasUsed'],16)*int(r['effectiveGasPrice'],16) for r in d['receipts']))")

step "4/4 everything read back from the chain"
forge script script/DeployMinds.s.sol --sig "check(address)" $LAUNCHER --rpc-url $RPC > $TMP 2>&1 || { tail -15 $TMP; die "the launcher is deployed at $LAUNCHER but it does not read back as meant"; }
grep -E "OK:|guardian|signer|cost sink|tokens launched" $TMP | sed 's/^ */  /'
[ "$(cast call $LAUNCHER "guardian()(address)" --rpc-url $RPC | tr A-Z a-z)" = "$(echo $MAIN | tr A-Z a-z)" ] || die "the guardian is not the main wallet"
[ "$(cast call $LAUNCHER "signer()(address)" --rpc-url $RPC | tr A-Z a-z)" = "$(echo $GAS | tr A-Z a-z)" ] || die "the signer is not the gas wallet"
[ "$(cast call $LAUNCHER "costSink()(address)" --rpc-url $RPC | tr A-Z a-z)" = "$(echo $COSTS | tr A-Z a-z)" ] || die "the cost sink is not the costs wallet"
echo "  it cost $(eth $SPENT) ETH"
echo
echo "DONE. Tell Claude these two lines:"
echo "MIND_LAUNCHER=$LAUNCHER"
echo "MIND_DEPLOY_BLOCK=$BLOCK"
