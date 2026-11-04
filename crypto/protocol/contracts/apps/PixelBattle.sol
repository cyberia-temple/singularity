// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PixelBattle — an on-chain 64×64 pixel canvas (r/place style).
/// @notice One pixel per transaction. Each pixel stores a 4-bit palette index
///         (0–15); the actual colors are defined by the frontend palette. Free
///         to paint — the sender only pays gas. No owner, fee, or cooldown.
contract PixelBattle {
    uint16 public constant WIDTH = 64;
    uint16 public constant HEIGHT = 64;
    uint16 public constant SIZE = WIDTH * HEIGHT; // 4096
    uint8 public constant PALETTE_SIZE = 16;

    // One byte per pixel, packed 32 per 256-bit word -> ceil(4096/32) = 128
    // words. Byte-aligned packing keeps paint() and getCanvas() simple.
    mapping(uint256 => uint256) private _words;

    /// @notice Total number of paints ever applied (every successful paint()).
    uint256 public totalPaints;

    event Painted(uint16 indexed x, uint16 indexed y, uint8 color, address indexed painter);

    /// @notice Paint a single pixel. `color` is a palette index in [0, 16).
    function paint(uint16 x, uint16 y, uint8 color) external {
        require(x < WIDTH && y < HEIGHT, "PixelBattle: out of bounds");
        require(color < PALETTE_SIZE, "PixelBattle: bad color");

        uint256 idx = uint256(y) * WIDTH + x;
        uint256 wi = idx >> 5; // / 32
        uint256 shift = (idx & 31) << 3; // (idx % 32) * 8 bits
        uint256 word = _words[wi];
        word &= ~(uint256(0xff) << shift);
        word |= uint256(color) << shift;
        _words[wi] = word;

        unchecked {
            totalPaints++;
        }
        emit Painted(x, y, color, msg.sender);
    }

    /// @notice Palette index of one pixel.
    function pixel(uint16 x, uint16 y) external view returns (uint8) {
        require(x < WIDTH && y < HEIGHT, "PixelBattle: out of bounds");
        uint256 idx = uint256(y) * WIDTH + x;
        return uint8(_words[idx >> 5] >> ((idx & 31) << 3));
    }

    /// @notice The whole canvas as SIZE bytes, row-major (index = y*WIDTH + x).
    ///         Each byte is the pixel's palette index. One RPC read renders the
    ///         entire board; a blank canvas is all zeros (palette index 0).
    function getCanvas() external view returns (bytes memory out) {
        out = new bytes(SIZE);
        uint256 words = (uint256(SIZE) + 31) / 32; // 128
        for (uint256 wi = 0; wi < words; wi++) {
            uint256 word = _words[wi];
            uint256 base = wi << 5;
            for (uint256 j = 0; j < 32; j++) {
                uint256 idx = base + j;
                if (idx >= SIZE) {
                    break;
                }
                out[idx] = bytes1(uint8(word >> (j << 3)));
            }
        }
    }
}
