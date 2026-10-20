// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

/// @title Wrapped CYBER
/// @notice WETH9 for Cyberia: one WCYBER is one CYBER held here, minted on deposit and burned on
/// withdrawal. Placed in genesis at a fixed address so every contract and wallet agrees on it.
/// @dev The one departure from WETH9 is that withdrawals forward with `call` instead of
/// `transfer`, so a smart-contract wallet whose `receive` needs more than 2300 gas can unwrap.
/// The balance is debited before the call, so a re-entering recipient finds nothing extra to take.
contract WCYBER {
    string public constant name = "Wrapped CYBER";
    string public constant symbol = "WCYBER";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error InsufficientBalance();
    error InsufficientAllowance();
    error NativeTransferFailed();

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        if (balanceOf[msg.sender] < wad) revert InsufficientBalance();
        balanceOf[msg.sender] -= wad;
        emit Withdrawal(msg.sender, wad);

        (bool ok,) = msg.sender.call{value: wad}("");
        if (!ok) revert NativeTransferFailed();
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        if (balanceOf[src] < wad) revert InsufficientBalance();

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            if (allowance[src][msg.sender] < wad) revert InsufficientAllowance();
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);
        return true;
    }
}
