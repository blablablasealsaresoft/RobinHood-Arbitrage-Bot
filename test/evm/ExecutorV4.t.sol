// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SequencerFlashArbExecutorV4 as Executor} from "../../contracts/SequencerFlashArbExecutorV4.sol";

// No forge-std dependency: these are Foundry's documented cheatcode interfaces.
interface Vm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function etch(address target, bytes calldata code) external;
    function chainId(uint256 id) external;
    function roll(uint256 height) external;
    function warp(uint256 timestamp) external;
    function txGasPrice(uint256 price) external;
    function prank(address caller) external;
    function expectRevert(bytes calldata reason) external;
}

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "token balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "token allowance");
        require(balanceOf[from] >= amount, "token balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract MockArbSys {
    uint256 public current;
    mapping(uint256 => bytes32) public hashes;
    function configure(uint256 height, uint256 anchor, bytes32 hash) external {
        current = height; hashes[anchor] = hash;
    }
    function arbBlockNumber() external view returns (uint256) { return current; }
    function arbBlockHash(uint256 n) external view returns (bytes32) { return hashes[n]; }
}

contract MockReserves {
    uint112 public a = 10000;
    uint112 public b = 20000;
    function change() external { a++; }
    function getReserves() external view returns (uint112, uint112, uint32) { return (a, b, 999); }
}

contract MockMorpho {
    enum Mode { Normal, Mutate, Double, NoCallback, RepaymentFailure, WrongAssets, Overpull, FailOnEntry }
    Mode public mode;
    function setMode(Mode value) external { mode = value; }
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(mode != Mode.FailOnEntry, "lender reached");
        MockToken(token).transfer(msg.sender, assets);
        if (mode == Mode.NoCallback) return;
        bytes memory payload = data;
        if (mode == Mode.Mutate) payload[payload.length-1] = bytes1(uint8(payload[payload.length-1]) ^ 1);
        Executor(msg.sender).onMorphoFlashLoan(mode == Mode.WrongAssets ? assets+1 : assets, payload);
        if (mode == Mode.Double) Executor(msg.sender).onMorphoFlashLoan(assets, payload);
        require(MockToken(token).allowance(msg.sender, address(this)) == assets, "not exact principal approval");
        require(mode != Mode.RepaymentFailure, "repayment failure");
        MockToken(token).transferFrom(msg.sender, address(this), mode == Mode.Overpull ? assets+1 : assets);
    }
}

contract MockAdapter {
    uint256 public numerator;
    uint256 public denominator;
    uint256 public fixedOutput;
    uint256 public reportExtra;
    bytes public reentry;
    constructor(uint256 n, uint256 d) { numerator = n; denominator = d; }
    function setOutput(uint256 n) external { fixedOutput = n; }
    function setReportExtra(uint256 n) external { reportExtra = n; }
    function setReentry(bytes calldata data) external { reentry = data; }
    function swap(address tokenIn, address tokenOut, uint256 amount, uint256, bytes calldata)
        external returns (uint256)
    {
        if (reentry.length > 0) {
            (bool ok, bytes memory result) = msg.sender.call(reentry);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
        }
        MockToken(tokenIn).transferFrom(msg.sender, address(this), amount);
        uint256 output = fixedOutput == 0 ? amount * numerator / denominator : fixedOutput;
        MockToken(tokenOut).transfer(msg.sender, output);
        return output + reportExtra;
    }
}

contract ExecutorV4Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY = 0x4663;
    uint256 constant BORROW = 1000 ether;
    uint256 constant BASELINE = 17 ether;
    uint256 constant INVENTORY = 1e30;
    address constant TREASURY = address(0xBEEF);
    bytes32 constant ANCHOR = keccak256("executed-L2-block-100");
    Executor ex;
    MockToken a;
    MockToken b;
    MockMorpho morpho;
    MockAdapter first;
    MockAdapter last;
    MockReserves pool;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(17000000); // Deliberately not the L2 height; catches block.number anchoring.
        vm.warp(1000);
        vm.txGasPrice(1);
        MockArbSys arb = new MockArbSys();
        vm.etch(address(0x64), address(arb).code);
        MockArbSys(address(0x64)).configure(101, 100, ANCHOR);
        a = new MockToken(); b = new MockToken(); morpho = new MockMorpho();
        first = new MockAdapter(2, 1); last = new MockAdapter(55, 100); pool = new MockReserves();
        ex = new Executor(address(this), vm.addr(KEY), TREASURY, address(morpho), 1, 1);
        ex.setRelayer(address(this), true);
        ex.setAdapter(address(first), true); ex.setAdapter(address(last), true);
        ex.setBorrowCap(address(a), BORROW);
        a.mint(address(morpho), INVENTORY); a.mint(address(last), INVENTORY);
        b.mint(address(first), INVENTORY); a.mint(address(ex), BASELINE);
    }

    function build(uint256 minProfit) internal view returns (
        Executor.FlashIntent memory intent, Executor.Leg[] memory legs, Executor.StateCheck[] memory checks
    ) {
        legs = new Executor.Leg[](2);
        legs[0] = Executor.Leg(address(first), address(a), address(b), 1, "");
        legs[1] = Executor.Leg(address(last), address(b), address(a), 1, "");
        checks = new Executor.StateCheck[](1);
        checks[0] = Executor.StateCheck(1, address(pool), hex"0902f1ac", keccak256(abi.encode(uint112(10000), uint112(20000))));
        intent = Executor.FlashIntent({ settlementToken: address(a), borrowAmount: BORROW, minProfit: minProfit,
            maxGasPrice: 1, anchorBlock: 100, anchorBlockHash: ANCHOR, validAfterBlock: 101,
            validUntilBlock: 101, deadline: 1002, nonce: 7, triggerTxHash: bytes32(0),
            routeHash: ex.hashLegs(legs), stateChecksHash: ex.hashStateChecks(checks) });
    }
    function signature(Executor.FlashIntent memory intent) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, ex.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }
    function execute(uint256 profit) internal {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(profit);
        ex.executeFlashArb(i, l, c, signature(i));
    }
    function unchanged() internal view {
        require(a.balanceOf(address(ex)) == BASELINE, "baseline changed");
        require(a.balanceOf(address(morpho)) == INVENTORY, "lender principal changed");
        require(a.balanceOf(TREASURY) == 0, "treasury changed on revert");
        require(!ex.isNonceUsed(7), "nonce consumed on revert");
    }

    function testProfitRepaymentAllowancesAndBaseline() public {
        execute(100 ether);
        require(a.balanceOf(TREASURY) == 100 ether, "incorrect profit");
        require(a.balanceOf(address(ex)) == BASELINE, "baseline swept");
        require(a.balanceOf(address(morpho)) == INVENTORY, "principal not repaid");
        require(a.allowance(address(ex), address(morpho)) == 0, "lender approval retained");
        require(a.allowance(address(ex), address(first)) == 0, "first approval retained");
        require(b.allowance(address(ex), address(last)) == 0, "last approval retained");
        require(b.balanceOf(address(ex)) == 0, "inventory exposure");
        require(ex.isNonceUsed(7), "nonce not consumed");
    }
    function testZeroMinProfitBreakEven() public {
        last.setOutput(BORROW); execute(0);
        require(a.balanceOf(TREASURY) == 0, "nonzero break-even profit");
        require(a.balanceOf(address(ex)) == BASELINE, "principal deficit");
    }
    function testOneUnitPrincipalDeficitRevertsAtomically() public {
        last.setOutput(BORROW-1);
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.expectRevert(bytes("pre-repay profit")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testPositiveProfitFloor() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(101 ether);
        bytes memory s = signature(i); vm.expectRevert(bytes("pre-repay profit")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testStaleStateRejectedBeforeLender() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); pool.change(); morpho.setMode(MockMorpho.Mode.FailOnEntry);
        vm.expectRevert(bytes("reserve mismatch")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testMutatedCallbackRejected() public { lenderFailure(MockMorpho.Mode.Mutate, "callback payload"); }
    function testDoubleCallbackRejected() public { lenderFailure(MockMorpho.Mode.Double, "unexpected callback"); }
    function testMissingCallbackRejected() public { lenderFailure(MockMorpho.Mode.NoCallback, "callback phase"); }
    function testWrongCallbackAmountRejected() public { lenderFailure(MockMorpho.Mode.WrongAssets, "borrow mismatch"); }
    function testRepaymentFailureRollsBackSwapsProfitAndNonce() public { lenderFailure(MockMorpho.Mode.RepaymentFailure, "repayment failure"); }
    function testLenderCannotPullMoreThanPrincipal() public { lenderFailure(MockMorpho.Mode.Overpull, "token allowance"); }
    function lenderFailure(MockMorpho.Mode mode, string memory reason) internal {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); morpho.setMode(mode);
        vm.expectRevert(bytes(reason)); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testOnlyMorphoCanCallBack() public {
        vm.expectRevert(bytes("not morpho")); ex.onMorphoFlashLoan(BORROW, "");
    }
    function testMorphoCannotCallBackWhenIdle() public {
        vm.prank(address(morpho)); vm.expectRevert(bytes("unexpected callback")); ex.onMorphoFlashLoan(BORROW, "");
    }
    function testReplayRejected() public {
        execute(0);
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.expectRevert(bytes("nonce used")); ex.executeFlashArb(i,l,c,s);
    }
    function testWrongSignerRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY+1, ex.hashIntent(i));
        vm.expectRevert(bytes("bad signature")); ex.executeFlashArb(i,l,c,abi.encodePacked(r,s,v)); unchanged();
    }
    function testWrongChainDomainRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.chainId(1);
        vm.expectRevert(bytes("bad signature")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testUnauthorizedRelayerRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.prank(address(0xBAD));
        vm.expectRevert(bytes("relayer not allowed")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testCurrentAnchorRejected() public { anchorFailure(100, ANCHOR, "anchor not previous"); }
    function testFutureAnchorRejected() public { anchorFailure(99, ANCHOR, "anchor not previous"); }
    function testStaleAnchorRejected() public { anchorFailure(102, ANCHOR, "anchor stale"); }
    function testWrongAnchorHashRejected() public { anchorFailure(101, keccak256("replacement"), "anchor hash"); }
    function anchorFailure(uint256 current, bytes32 h, string memory reason) internal {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); MockArbSys(address(0x64)).configure(current,100,h);
        vm.expectRevert(bytes(reason)); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testExpiredIntentRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.warp(1003);
        vm.expectRevert(bytes("expired")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testGasCapRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); vm.txGasPrice(2);
        vm.expectRevert(bytes("gas price")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testEachLegMinOutIsEnforced() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        l[0].minOut = BORROW*2+1; i.routeHash = ex.hashLegs(l); bytes memory s = signature(i);
        vm.expectRevert(bytes("leg minOut")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testAdapterCannotOverreportOutput() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); first.setReportExtra(1);
        vm.expectRevert(bytes("bad adapter report")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testAdapterReentrancyRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); first.setReentry(abi.encodeCall(ex.executeFlashArb,(i,l,c,s)));
        vm.expectRevert(bytes("busy")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testNonAllowlistedAdapterRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s = signature(i); ex.setAdapter(address(first),false);
        vm.expectRevert(bytes("adapter not allowed")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testBrokenRouteRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        l[1].tokenIn=address(a); i.routeHash=ex.hashLegs(l); bytes memory s=signature(i);
        vm.expectRevert(bytes("broken route")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testOpenRouteRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        l[1].tokenOut=address(b); i.routeHash=ex.hashLegs(l); bytes memory s=signature(i);
        vm.expectRevert(bytes("route end")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testNoStateChecksRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l,) = build(0);
        Executor.StateCheck[] memory c=new Executor.StateCheck[](0);i.stateChecksHash=ex.hashStateChecks(c);bytes memory s=signature(i);
        vm.expectRevert(bytes("no state checks")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testBorrowCapRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s=signature(i);ex.setBorrowCap(address(a),BORROW-1);
        vm.expectRevert(bytes("borrow disabled/capped")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testPausedExecutorRejected() public {
        (Executor.FlashIntent memory i, Executor.Leg[] memory l, Executor.StateCheck[] memory c) = build(0);
        bytes memory s=signature(i);ex.setPaused(true);
        vm.expectRevert(bytes("paused")); ex.executeFlashArb(i,l,c,s); unchanged();
    }
    function testFuzzPrincipalBaselineAndProfitAreConserved(uint96 profit) public {
        last.setOutput(BORROW+uint256(profit));execute(uint256(profit));
        require(a.balanceOf(TREASURY)==uint256(profit),"profit conservation");
        require(a.balanceOf(address(ex))==BASELINE,"baseline conservation");
        require(a.balanceOf(address(morpho))==INVENTORY,"principal conservation");
    }
}
