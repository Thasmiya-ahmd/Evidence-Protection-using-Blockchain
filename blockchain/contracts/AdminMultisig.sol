// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// M-of-N approval wallet. Its owners ARE the system admins.
/// Every admin decision (approve a profile, approve evidence, assign an analyst,
/// register courts/stations/labs, add or remove admins) needs `threshold` approvals.
contract AdminMultisig {
    struct Proposal {
        address to;
        bytes data;
        bool executed;
    }

    address[] private owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;

    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    event Proposed(
        uint256 indexed id,
        address indexed by,
        address to,
        bytes data
    );
    event Approved(uint256 indexed id, address indexed by);
    event ApprovalRevoked(uint256 indexed id, address indexed by);
    event Executed(uint256 indexed id, address indexed by);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not an admin");
        _;
    }

    modifier onlySelf() {
        require(
            msg.sender == address(this),
            "Only through an approved proposal"
        );
        _;
    }

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_owners.length >= 2, "Need at least 2 admins");
        require(
            _threshold >= 2 && _threshold <= _owners.length,
            "Bad threshold"
        );
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0) && !isOwner[o], "Bad admin address");
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = _threshold;
    }

    // ---------- Proposals ----------

    /// An admin proposes a call (the proposer's approval counts automatically)
    function propose(
        address to,
        bytes calldata data
    ) external onlyOwner returns (uint256 id) {
        id = proposals.length;
        Proposal storage p = proposals.push();
        p.to = to;
        p.data = data;
        approvedBy[id][msg.sender] = true;
        emit Proposed(id, msg.sender, to, data);
    }

    function approve(uint256 id) external onlyOwner {
        require(id < proposals.length, "No such proposal");
        require(!proposals[id].executed, "Already executed");
        require(!approvedBy[id][msg.sender], "Already approved");
        approvedBy[id][msg.sender] = true;
        emit Approved(id, msg.sender);
    }

    function revokeApproval(uint256 id) external onlyOwner {
        require(id < proposals.length, "No such proposal");
        require(!proposals[id].executed, "Already executed");
        require(approvedBy[id][msg.sender], "Not approved");
        approvedBy[id][msg.sender] = false;
        emit ApprovalRevoked(id, msg.sender);
    }

    /// Runs the call once enough CURRENT admins approved. Approvals from removed admins don't count.
    /// If the call fails, its original error message is passed through.
    function execute(uint256 id) external onlyOwner {
        require(id < proposals.length, "No such proposal");
        Proposal storage p = proposals[id];
        require(!p.executed, "Already executed");
        require(approvalsOf(id) >= threshold, "Not enough approvals");
        p.executed = true;
        (bool ok, bytes memory ret) = p.to.call(p.data);
        if (!ok) {
            if (ret.length == 0) revert("Call failed");
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit Executed(id, msg.sender);
    }

    // ---------- Managing the admins (only through an approved proposal) ----------

    function addOwner(address o) external onlySelf {
        require(o != address(0) && !isOwner[o], "Bad admin address");
        isOwner[o] = true;
        owners.push(o);
        emit OwnerAdded(o);
    }

    function removeOwner(address o) external onlySelf {
        require(isOwner[o], "Not an admin");
        require(
            owners.length - 1 >= 2 && owners.length - 1 >= threshold,
            "Would break the approval threshold"
        );
        isOwner[o] = false;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == o) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }
        emit OwnerRemoved(o);
    }

    function changeThreshold(uint256 t) external onlySelf {
        require(t >= 2 && t <= owners.length, "Bad threshold");
        threshold = t;
        emit ThresholdChanged(t);
    }

    // ---------- Read ----------

    function approvalsOf(uint256 id) public view returns (uint256 n) {
        require(id < proposals.length, "No such proposal");
        for (uint256 i = 0; i < owners.length; i++) {
            if (approvedBy[id][owners[i]]) n++;
        }
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(
        uint256 id
    )
        external
        view
        returns (
            address to,
            bytes memory data,
            bool executed,
            uint256 approvals
        )
    {
        require(id < proposals.length, "No such proposal");
        Proposal storage p = proposals[id];
        return (p.to, p.data, p.executed, approvalsOf(id));
    }
}
