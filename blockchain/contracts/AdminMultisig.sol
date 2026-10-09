// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// M-of-N approval wallet. It holds the registry's Admin role, so every admin
/// action (register court, assign official, grant/revoke role) needs several approvals.
contract AdminMultisig {
    struct Proposal {
        address to;
        bytes data;
        bool executed;
        uint256 approvals;
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

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not an owner");
        _;
    }

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_owners.length >= 2, "Need at least 2 owners");
        require(
            _threshold >= 2 && _threshold <= _owners.length,
            "Bad threshold"
        );
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0) && !isOwner[o], "Bad owner");
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = _threshold;
    }

    /// An owner proposes a call (the proposer's approval counts automatically)
    function propose(
        address to,
        bytes calldata data
    ) external onlyOwner returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal(to, data, false, 1));
        approvedBy[id][msg.sender] = true;
        emit Proposed(id, msg.sender, to, data);
    }

    function approve(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        require(!p.executed, "Already executed");
        require(!approvedBy[id][msg.sender], "Already approved");
        approvedBy[id][msg.sender] = true;
        p.approvals++;
        emit Approved(id, msg.sender);
    }

    function revokeApproval(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        require(!p.executed, "Already executed");
        require(approvedBy[id][msg.sender], "Not approved");
        approvedBy[id][msg.sender] = false;
        p.approvals--;
        emit ApprovalRevoked(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        require(!p.executed, "Already executed");
        require(p.approvals >= threshold, "Not enough approvals");
        p.executed = true;
        (bool ok, ) = p.to.call(p.data);
        require(ok, "Call failed");
        emit Executed(id, msg.sender);
    }

    // ---------- Read ----------
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
        Proposal storage p = proposals[id];
        return (p.to, p.data, p.executed, p.approvals);
    }
}
