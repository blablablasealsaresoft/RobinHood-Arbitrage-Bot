// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV4TickStorage {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice Aggregate pre-borrow commitment for a bounded V4 bitmap window.
/// @dev Storage layout matches v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75.
///      The signer must prove complete bitmap/tick coverage off-chain and pin
///      this lens and the manager's reviewed runtime bytecode. Not an oracle.
contract V4TickStateLens {
    IV4TickStorage public immutable poolManager;

    constructor(address manager) {
        require(manager != address(0) && manager.code.length > 0, "bad manager");
        poolManager = IV4TickStorage(manager);
    }

    function hashV4State(bytes32 poolId, int16 minWord, uint16 wordCount, int24[] calldata ticks)
        external view returns (bytes32)
    {
        require(wordCount > 0 && wordCount <= 8 && ticks.length <= 256, "window bounds");
        require(int256(minWord) + int256(uint256(wordCount)) - 1 <= type(int16).max, "word overflow");
        bytes32 base = keccak256(abi.encode(poolId, uint256(6)));
        uint256 slot0 = uint256(poolManager.extsload(base)) & ((uint256(1) << 232) - 1);
        uint256 liquidity = uint256(poolManager.extsload(bytes32(uint256(base) + 3))) & type(uint128).max;
        uint256[] memory bitmaps = new uint256[](wordCount);
        for (uint256 i; i < wordCount; ++i) {
            int16 position = int16(int256(minWord) + int256(i));
            bytes32 slot = keccak256(abi.encode(position, uint256(base) + 5));
            bitmaps[i] = uint256(poolManager.extsload(slot));
        }
        uint256[] memory tickData = new uint256[](ticks.length);
        for (uint256 i; i < ticks.length; ++i) {
            require(ticks[i] >= -887272 && ticks[i] <= 887272, "tick range");
            if (i > 0) require(ticks[i] > ticks[i - 1], "tick order");
            bytes32 slot = keccak256(abi.encode(ticks[i], uint256(base) + 4));
            tickData[i] = uint256(poolManager.extsload(slot));
        }
        return keccak256(abi.encode(poolId, slot0, liquidity, minWord, bitmaps, ticks, tickData));
    }
}
