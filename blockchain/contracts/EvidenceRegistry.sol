// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Blockchain-Based Evidence Protection and Chain of Custody (case-based access)
/// @dev Keep on-chain text GENERIC (e.g. "Seized laptop"). Names, addresses and detailed
///      notes belong in the off-chain database. On-chain data can never be deleted.
contract EvidenceRegistry is AccessControl {
    // ---------- Roles (Admin = DEFAULT_ADMIN_ROLE, held by the AdminMultisig) ----------
    bytes32 public constant INVESTIGATOR_ROLE = keccak256("INVESTIGATOR_ROLE");
    bytes32 public constant FORENSIC_ROLE = keccak256("FORENSIC_ROLE");
    bytes32 public constant COURT_ROLE = keccak256("COURT_ROLE");

    // ---------- Types ----------
    enum CaseStatus {
        None,
        Open,
        Rejected,
        Closed
    }
    enum Stage {
        Collected,
        ForensicAnalysis,
        SubmittedToCourt
    }
    enum Status {
        Active,
        Flagged,
        Revoked
    }

    struct Case {
        string caseId;
        string title; // keep generic
        string location; // jurisdiction location chosen by the investigator
        bytes32 courtId; // court resolved automatically from the location
        address leadInvestigator;
        CaseStatus status;
        uint256 createdAt;
    }

    struct Evidence {
        uint256 id;
        string caseId;
        string description; // keep generic
        string location; // short place of collection, not a full address
        string collectionMethod; // short, e.g. "Seized", "Imaged on site"
        bytes32 fileHash; // SHA-256 of the evidence file
        bytes32 certificateHash; // hash of the electronic-evidence certificate (0 if not applicable)
        address collector;
        address currentHolder;
        Stage stage;
        Status status;
        uint256 createdAt;
    }

    /// Input for registration (a struct keeps the function simple)
    struct NewEvidence {
        string caseId;
        string description;
        string location;
        string collectionMethod;
        bytes32 fileHash;
        bytes32 certificateHash;
    }

    struct CustodyRecord {
        address from;
        address to;
        Stage stage;
        string reason;
        uint256 timestamp;
    }

    struct StatusRecord {
        Status status;
        address by;
        string reason;
        uint256 timestamp;
    }

    // ---------- Storage ----------
    // Courts: registered with a location, nothing is predefined in code
    bytes32[] private courtIds;
    string[] private locations;
    mapping(bytes32 => string) public courtName; // courtId => name
    mapping(bytes32 => string) public courtLocation; // courtId => location
    mapping(bytes32 => bytes32) private locationToCourt; // keccak256(location) => courtId
    mapping(address => bytes32) public officialCourt; // court official => courtId

    bytes32[] private caseKeys; // key = keccak256(caseId)
    mapping(bytes32 => Case) private cases;
    mapping(bytes32 => mapping(address => bool)) private isAnalyst;
    mapping(bytes32 => address[]) private analysts;
    mapping(bytes32 => uint256[]) private caseEvidence;

    uint256 public count;
    mapping(uint256 => Evidence) private evidences;
    mapping(uint256 => CustodyRecord[]) private history;
    mapping(uint256 => StatusRecord[]) private statusHistory;
    mapping(bytes32 => uint256) public hashToId;

    // ---------- Events (audit log + court notifications) ----------
    event CourtRegistered(
        bytes32 indexed courtId,
        string name,
        string location
    );
    event CourtOfficialAssigned(
        bytes32 indexed courtId,
        address indexed official
    );

    // The court of that location listens to these three (filter by courtId)
    event CaseOpened(
        bytes32 indexed courtId,
        bytes32 indexed caseKey,
        address indexed investigator,
        string caseId,
        uint256 timestamp
    );
    event EvidenceRegistered(
        uint256 indexed id,
        bytes32 indexed courtId,
        address indexed collector,
        bytes32 caseKey,
        bytes32 fileHash,
        uint256 timestamp
    );
    event EvidenceSubmittedToCourt(
        uint256 indexed id,
        bytes32 indexed courtId,
        address indexed by,
        uint256 timestamp
    );

    event CaseDecision(
        bytes32 indexed courtId,
        bytes32 indexed caseKey,
        address indexed by,
        CaseStatus status,
        string note,
        uint256 timestamp
    );
    event AnalystAssigned(
        bytes32 indexed caseKey,
        address indexed analyst,
        address indexed by,
        uint256 timestamp
    );
    event AnalystRemoved(
        bytes32 indexed caseKey,
        address indexed analyst,
        address indexed by,
        uint256 timestamp
    );
    event CustodyTransferred(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        Stage stage,
        string reason,
        uint256 timestamp
    );
    event EvidenceVerified(
        uint256 indexed id,
        address indexed verifier,
        bool intact,
        uint256 timestamp
    );
    event EvidenceStatusChanged(
        uint256 indexed id,
        Status status,
        address indexed by,
        string reason,
        uint256 timestamp
    );
    event EvidenceAccessed(
        uint256 indexed id,
        address indexed accessor,
        string purpose,
        uint256 timestamp
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // =====================================================
    // Internal helpers
    // =====================================================
    function _isCourtOf(
        address a,
        bytes32 courtId
    ) internal view returns (bool) {
        return hasRole(COURT_ROLE, a) && officialCourt[a] == courtId;
    }

    function _caseKey(Evidence storage e) internal view returns (bytes32) {
        return keccak256(bytes(e.caseId));
    }

    /// Who may see a case and its evidence: lead investigator, assigned analysts, the case's court
    function _canViewCase(address a, bytes32 key) internal view returns (bool) {
        Case storage c = cases[key];
        if (c.status == CaseStatus.None) return false;
        return
            a == c.leadInvestigator ||
            isAnalyst[key][a] ||
            _isCourtOf(a, c.courtId);
    }

    function _viewable(uint256 id) internal view returns (Evidence storage e) {
        e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(
            _canViewCase(msg.sender, _caseKey(e)),
            "Not authorized for this case"
        );
    }

    function _setStatus(
        uint256 id,
        Status newStatus,
        string memory reason
    ) internal {
        evidences[id].status = newStatus;
        statusHistory[id].push(
            StatusRecord(newStatus, msg.sender, reason, block.timestamp)
        );
        emit EvidenceStatusChanged(
            id,
            newStatus,
            msg.sender,
            reason,
            block.timestamp
        );
    }

    /// Court decision on an open case (reject or close)
    function _decide(
        string memory caseId,
        CaseStatus to,
        string memory note
    ) internal {
        bytes32 key = keccak256(bytes(caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(_isCourtOf(msg.sender, c.courtId), "Not this case's court");
        c.status = to;
        emit CaseDecision(
            c.courtId,
            key,
            msg.sender,
            to,
            note,
            block.timestamp
        );
    }

    // =====================================================
    // Admin: courts (Admin is the multisig, so these need several approvals)
    // =====================================================

    /// Register a court for a location. One court per location.
    function registerCourt(
        string calldata name,
        string calldata location
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            bytes(name).length > 0 && bytes(location).length > 0,
            "Name and location required"
        );
        bytes32 id = keccak256(bytes(name));
        bytes32 locKey = keccak256(bytes(location));
        require(bytes(courtName[id]).length == 0, "Court exists");
        require(
            locationToCourt[locKey] == bytes32(0),
            "Location already has a court"
        );

        courtName[id] = name;
        courtLocation[id] = location;
        locationToCourt[locKey] = id;
        courtIds.push(id);
        locations.push(location);
        emit CourtRegistered(id, name, location);
    }

    /// Use this (not grantRole) so the official is tied to one court
    function assignCourtOfficial(
        address official,
        bytes32 courtId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bytes(courtName[courtId]).length > 0, "Unknown court");
        officialCourt[official] = courtId;
        _grantRole(COURT_ROLE, official);
        emit CourtOfficialAssigned(courtId, official);
    }

    // =====================================================
    // Cases
    // =====================================================

    /// Investigator opens a case for a location. The location's court is linked
    /// automatically and notified.
    function openCase(
        string calldata caseId,
        string calldata title,
        string calldata location
    ) external onlyRole(INVESTIGATOR_ROLE) {
        require(bytes(caseId).length > 0, "Case ID required");
        bytes32 courtId = locationToCourt[keccak256(bytes(location))];
        require(courtId != bytes32(0), "No court registered for this location");
        bytes32 key = keccak256(bytes(caseId));
        require(cases[key].status == CaseStatus.None, "Case ID already used");

        Case storage c = cases[key];
        c.caseId = caseId;
        c.title = title;
        c.location = location;
        c.courtId = courtId;
        c.leadInvestigator = msg.sender;
        c.status = CaseStatus.Open;
        c.createdAt = block.timestamp;

        caseKeys.push(key);
        emit CaseOpened(courtId, key, msg.sender, caseId, block.timestamp);
    }

    /// Court rejects a case (e.g. wrong jurisdiction). No new evidence or transfers after this.
    function rejectCase(
        string calldata caseId,
        string calldata reason
    ) external {
        _decide(caseId, CaseStatus.Rejected, reason);
    }

    function closeCase(string calldata caseId, string calldata note) external {
        _decide(caseId, CaseStatus.Closed, note);
    }

    /// Lead investigator adds a forensic analyst to the case
    function assignAnalyst(string calldata caseId, address analyst) external {
        bytes32 key = keccak256(bytes(caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(msg.sender == c.leadInvestigator, "Only lead investigator");
        require(hasRole(FORENSIC_ROLE, analyst), "Not a forensic analyst");
        require(!isAnalyst[key][analyst], "Already assigned");

        isAnalyst[key][analyst] = true;
        analysts[key].push(analyst);
        emit AnalystAssigned(key, analyst, msg.sender, block.timestamp);
    }

    /// Lead investigator removes an analyst. Blocked while the analyst still holds
    /// (non-submitted) evidence on this case, so custody can never get stuck.
    function removeAnalyst(string calldata caseId, address analyst) external {
        bytes32 key = keccak256(bytes(caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(msg.sender == c.leadInvestigator, "Only lead investigator");
        require(isAnalyst[key][analyst], "Not assigned to this case");

        uint256[] storage ids = caseEvidence[key];
        for (uint256 i = 0; i < ids.length; i++) {
            Evidence storage ev = evidences[ids[i]];
            if (ev.stage != Stage.SubmittedToCourt) {
                require(
                    ev.currentHolder != analyst,
                    "Analyst still holds evidence"
                );
            }
        }

        isAnalyst[key][analyst] = false;
        address[] storage list = analysts[key];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == analyst) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        emit AnalystRemoved(key, analyst, msg.sender, block.timestamp);
    }

    // =====================================================
    // Evidence
    // =====================================================

    /// Register evidence under an open case. Notifies the case's court.
    function registerEvidence(
        NewEvidence calldata input
    ) external onlyRole(INVESTIGATOR_ROLE) returns (uint256 id) {
        bytes32 key = keccak256(bytes(input.caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(c.leadInvestigator == msg.sender, "Not lead investigator");
        require(input.fileHash != bytes32(0), "Empty hash");
        require(hashToId[input.fileHash] == 0, "Evidence already registered");

        id = ++count;

        Evidence storage e = evidences[id];
        e.id = id;
        e.caseId = input.caseId;
        e.description = input.description;
        e.location = input.location;
        e.collectionMethod = input.collectionMethod;
        e.fileHash = input.fileHash;
        e.certificateHash = input.certificateHash;
        e.collector = msg.sender;
        e.currentHolder = msg.sender;
        e.stage = Stage.Collected;
        e.status = Status.Active;
        e.createdAt = block.timestamp;

        hashToId[input.fileHash] = id;
        caseEvidence[key].push(id);
        history[id].push(
            CustodyRecord(
                address(0),
                msg.sender,
                Stage.Collected,
                "Evidence collected",
                block.timestamp
            )
        );

        emit EvidenceRegistered(
            id,
            c.courtId,
            msg.sender,
            key,
            input.fileHash,
            block.timestamp
        );
    }

    /// Current holder passes evidence to the lead investigator or an assigned analyst
    function transferCustody(
        uint256 id,
        address newHolder,
        string calldata reason
    ) external {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.status == Status.Active, "Evidence is flagged or revoked");
        require(
            e.stage != Stage.SubmittedToCourt,
            "Already submitted to court"
        );
        require(
            msg.sender == e.currentHolder,
            "Only current holder can transfer"
        );
        require(
            newHolder != address(0) && newHolder != msg.sender,
            "Invalid recipient"
        );

        bytes32 key = _caseKey(e);
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");

        Stage newStage;
        if (newHolder == c.leadInvestigator) newStage = Stage.Collected;
        else if (isAnalyst[key][newHolder]) newStage = Stage.ForensicAnalysis;
        else revert("Recipient not on this case");

        e.currentHolder = newHolder;
        e.stage = newStage;
        history[id].push(
            CustodyRecord(
                msg.sender,
                newHolder,
                newStage,
                reason,
                block.timestamp
            )
        );
        emit CustodyTransferred(
            id,
            msg.sender,
            newHolder,
            newStage,
            reason,
            block.timestamp
        );
    }

    /// Current holder submits evidence to the court. Notifies the court.
    function submitToCourt(uint256 id, string calldata note) external {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.status == Status.Active, "Evidence is flagged or revoked");
        require(e.stage != Stage.SubmittedToCourt, "Already submitted");
        require(msg.sender == e.currentHolder, "Only current holder");

        Case storage c = cases[_caseKey(e)];
        require(c.status == CaseStatus.Open, "Case is not open");

        e.stage = Stage.SubmittedToCourt;
        history[id].push(
            CustodyRecord(
                msg.sender,
                msg.sender,
                Stage.SubmittedToCourt,
                note,
                block.timestamp
            )
        );
        emit EvidenceSubmittedToCourt(
            id,
            c.courtId,
            msg.sender,
            block.timestamp
        );
    }

    /// Verify a hash and log the result on-chain (audit entry)
    function recordVerification(
        uint256 id,
        bytes32 fileHash
    ) external returns (bool) {
        Evidence storage e = _viewable(id);
        bool intact = e.fileHash == fileHash;
        emit EvidenceVerified(id, msg.sender, intact, block.timestamp);
        return intact;
    }

    /// Log that someone viewed or downloaded the evidence
    function logAccess(uint256 id, string calldata purpose) external {
        _viewable(id);
        emit EvidenceAccessed(id, msg.sender, purpose, block.timestamp);
    }

    // ---------- Flag / resolve / revoke ----------

    /// Anyone on the case (including the court) can dispute evidence. It is frozen until resolved.
    function flagEvidence(uint256 id, string calldata reason) external {
        Evidence storage e = _viewable(id);
        require(e.status == Status.Active, "Evidence is not active");
        _setStatus(id, Status.Flagged, reason);
    }

    /// Only the case's court clears a flag
    function resolveFlag(uint256 id, string calldata note) external {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(
            _isCourtOf(msg.sender, cases[_caseKey(e)].courtId),
            "Not this case's court"
        );
        require(e.status == Status.Flagged, "Evidence is not flagged");
        _setStatus(id, Status.Active, note);
    }

    /// Only the case's court can permanently revoke. The record stays on the chain.
    function revokeEvidence(uint256 id, string calldata reason) external {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(
            _isCourtOf(msg.sender, cases[_caseKey(e)].courtId),
            "Not this case's court"
        );
        require(e.status != Status.Revoked, "Already revoked");
        _setStatus(id, Status.Revoked, reason);
    }

    // =====================================================
    // Read functions (restricted to people on the case)
    // =====================================================

    function verify(uint256 id, bytes32 fileHash) external view returns (bool) {
        return _viewable(id).fileHash == fileHash;
    }

    function getEvidence(uint256 id) external view returns (Evidence memory) {
        return _viewable(id);
    }

    function getCustodyHistory(
        uint256 id
    ) external view returns (CustodyRecord[] memory) {
        _viewable(id);
        return history[id];
    }

    function getStatusHistory(
        uint256 id
    ) external view returns (StatusRecord[] memory) {
        _viewable(id);
        return statusHistory[id];
    }

    function getCase(
        string calldata caseId
    ) external view returns (Case memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(_canViewCase(msg.sender, key), "Not authorized for this case");
        return cases[key];
    }

    function getAnalysts(
        string calldata caseId
    ) external view returns (address[] memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(_canViewCase(msg.sender, key), "Not authorized for this case");
        return analysts[key];
    }

    function getCaseEvidence(
        string calldata caseId
    ) external view returns (Evidence[] memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(_canViewCase(msg.sender, key), "Not authorized for this case");
        uint256[] storage ids = caseEvidence[key];
        Evidence[] memory list = new Evidence[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = evidences[ids[i]];
        }
        return list;
    }

    /// Cases the caller may see (a court official sees all cases of their court)
    function getMyCases() external view returns (Case[] memory) {
        uint256 n = 0;
        for (uint256 i = 0; i < caseKeys.length; i++) {
            if (_canViewCase(msg.sender, caseKeys[i])) n++;
        }
        Case[] memory list = new Case[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < caseKeys.length; i++) {
            if (_canViewCase(msg.sender, caseKeys[i])) {
                list[k] = cases[caseKeys[i]];
                k++;
            }
        }
        return list;
    }

    /// IDs of evidence the caller currently holds
    function getMyHeldEvidence() external view returns (uint256[] memory) {
        uint256 n = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (evidences[i].currentHolder == msg.sender) n++;
        }
        uint256[] memory ids = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (evidences[i].currentHolder == msg.sender) {
                ids[k] = i;
                k++;
            }
        }
        return ids;
    }

    // ---------- Public info (no case data): used by the location dropdown ----------

    /// All locations that have a registered court (fill the location dropdown with this)
    function getLocations() external view returns (string[] memory) {
        return locations;
    }

    /// The court for a selected location (show this under the dropdown)
    function getCourtForLocation(
        string calldata location
    ) external view returns (bytes32 id, string memory name) {
        id = locationToCourt[keccak256(bytes(location))];
        name = courtName[id];
    }

    function getCourts()
        external
        view
        returns (
            bytes32[] memory ids,
            string[] memory names,
            string[] memory locs
        )
    {
        ids = courtIds;
        names = new string[](courtIds.length);
        locs = new string[](courtIds.length);
        for (uint256 i = 0; i < courtIds.length; i++) {
            names[i] = courtName[courtIds[i]];
            locs[i] = courtLocation[courtIds[i]];
        }
    }

    function getUserRole(address a) external view returns (string memory) {
        if (hasRole(DEFAULT_ADMIN_ROLE, a)) return "Admin";
        if (hasRole(COURT_ROLE, a)) return "Court Official";
        if (hasRole(FORENSIC_ROLE, a)) return "Forensic Analyst";
        if (hasRole(INVESTIGATOR_ROLE, a)) return "Investigator";
        return "None";
    }
}
