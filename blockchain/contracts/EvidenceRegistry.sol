// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EvidenceRegistry {
    struct Evidence {
        string caseId;
        bytes32 fileHash;
        address owner;
        uint256 timestamp;
    }

    mapping(uint256 => Evidence) public evidences;
    uint256 public count;

    event EvidenceRegistered(uint256 id, string caseId, bytes32 fileHash, address owner);

    function register(string memory caseId, bytes32 fileHash) public {
        count++;
        evidences[count] = Evidence(caseId, fileHash, msg.sender, block.timestamp);
        emit EvidenceRegistered(count, caseId, fileHash, msg.sender);
    }

    function verify(uint256 id, bytes32 fileHash) public view returns (bool) {
        return evidences[id].fileHash == fileHash;
    }
}