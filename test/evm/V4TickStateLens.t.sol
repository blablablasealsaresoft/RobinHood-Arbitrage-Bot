// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../../contracts/V4TickStateLens.sol";
interface VmTickLens { function expectRevert(bytes calldata) external; }
contract TickStorageMock is IV4TickStorage {
    mapping(bytes32=>bytes32) public values;
    function set(bytes32 slot,bytes32 value) external {values[slot]=value;}
    function extsload(bytes32 slot) external view returns(bytes32){return values[slot];}
}
contract V4TickStateLensTest {
    VmTickLens constant vm=VmTickLens(address(uint160(uint256(keccak256("hevm cheat code")))));
    TickStorageMock manager; V4TickStateLens lens;
    bytes32 constant ID=0x3b71cf9f678074236c5e7d7c8b2eff0e112b626189e6f93563b75935cf32f619;
    bytes32 constant GOLDEN=0xf588933f1cd87faa5efa0c20b25a38cf9ed61de92572b777b702bb07cef6b3b6;
    bytes32 base;
    function setUp() public {
        manager=new TickStorageMock();lens=new V4TickStateLens(address(manager));
        base=keccak256(abi.encode(ID,uint256(6)));
        manager.set(base,bytes32((uint256(1)<<96)|(uint256(600)<<208)));
        manager.set(bytes32(uint256(base)+3),bytes32(uint256(1000)));
        manager.set(keccak256(abi.encode(int16(-1),uint256(base)+5)),bytes32(uint256(1)<<255));
        manager.set(keccak256(abi.encode(int16(0),uint256(base)+5)),bytes32(uint256(2)));
        _tick(-60,1000,1000);_tick(60,1000,-1000);
    }
    function _tick(int24 tick,uint128 gross,int128 net) internal {
        manager.set(keccak256(abi.encode(tick,uint256(base)+4)),bytes32(uint256(gross)|(uint256(uint128(net))<<128)));
    }
    function _ticks() internal pure returns(int24[] memory ticks){ticks=new int24[](2);ticks[0]=-60;ticks[1]=60;}
    function testIndependentGoldenFingerprint() public view {require(lens.hashV4State(ID,-1,2,_ticks())==GOLDEN,"golden mismatch");}
    function testTickMutationChangesFingerprint() public {_tick(60,1002,-1000);require(lens.hashV4State(ID,-1,2,_ticks())!=GOLDEN,"missed tick change");}
    function testNewInitializedBitChangesFingerprint() public {manager.set(keccak256(abi.encode(int16(0),uint256(base)+5)),bytes32(uint256(3)));require(lens.hashV4State(ID,-1,2,_ticks())!=GOLDEN,"missed bitmap change");}
    function testActiveLiquidityChangesFingerprint() public {manager.set(bytes32(uint256(base)+3),bytes32(uint256(1001)));require(lens.hashV4State(ID,-1,2,_ticks())!=GOLDEN,"missed liquidity change");}
    function testSlot0ChangesFingerprint() public {manager.set(base,bytes32((uint256(1)<<96)|(uint256(601)<<208)));require(lens.hashV4State(ID,-1,2,_ticks())!=GOLDEN,"missed fee change");}
    function testFeeGrowthNotAnEconomicQuoteInput() public {manager.set(bytes32(uint256(base)+1),bytes32(uint256(7)));require(lens.hashV4State(ID,-1,2,_ticks())==GOLDEN,"irrelevant fee growth changed digest");}
    function testWindowBoundsRevert() public {vm.expectRevert(abi.encodeWithSignature("Error(string)","window bounds"));lens.hashV4State(ID,-1,9,_ticks());}
    function testTickOrderingRevert() public {int24[] memory ticks=_ticks();ticks[1]=-60;vm.expectRevert(abi.encodeWithSignature("Error(string)","tick order"));lens.hashV4State(ID,-1,2,ticks);}
}
