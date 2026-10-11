// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AdminMultisig.sol";
import "./PeopleRegistry.sol";

/// @title Evidence chain of custody: admin-reviewed evidence, station-based officers, court notification.
/// @dev Keep on-chain text GENERIC (e.g. "Seized laptop"). Names, addresses and detailed
///      notes belong in the off-chain database. On-chain data can never be deleted.
///      Use a unique case ID such as "<station>/<crime no>/<year>".
contract EvidenceRegistry {
    AdminMultisig public immutable admins;
    PeopleRegistry public immutable people;

    // ---------- Types ----------
    enum CaseStatus {
        None,
        Open,
        Rejected,
        Closed
    }
    enum Review {
        Pending,
        Approved,
        Rejected
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
    enum Action {
        Registered,
        Approved,
        Rejected,
        Offered,
        Accepted,
        OfferCancelled,
        Reassigned,
        SubmittedToCourt
    }

    struct Case {
        string caseId;
        string title; // keep generic
        uint256 stationId;
        uint256 courtId; // found automatically from the station's location
        address leadInvestigator;
        CaseStatus status;
        uint256 createdAt;
    }

    struct Evidence {
        uint256 id;
        string caseId;
        string description; // keep generic
        string location; // short place of seizure, not a full address
        string collectionMethod; // short, e.g. "Seized", "Imaged on site"
        bytes32 fileHash; // SHA-256 of the evidence file
        address collector;
        address currentHolder;
        Stage stage;
        Status status;
        Review review;
        uint256 createdAt;
    }

    /// Supporting documents (hashes of files kept off-chain)
    struct Docs {
        uint64 seizedAt; // when the item was seized (unix seconds)
        bool isElectronic;
        bytes32 seizureMemoHash; // seizure memo / panchnama (required)
        bytes32 recordingHash; // audio-video recording of search and seizure (optional)
        bytes32 certificateHash; // electronic-record certificate (required if isElectronic)
    }

    struct NewEvidence {
        string caseId;
        string description;
        string location;
        string collectionMethod;
        bytes32 fileHash;
        Docs docs;
    }

    struct CustodyRecord {
        Action action;
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

    struct Report {
        address analyst;
        bytes32 reportHash;
        string note;
        uint256 timestamp;
    }

    // ---------- Storage ----------
    bytes32[] private caseKeys; // key = keccak256(caseId)
    mapping(bytes32 => Case) private cases;
    mapping(bytes32 => mapping(address => bool)) private isAnalyst;
    mapping(bytes32 => address[]) private analysts;
    mapping(bytes32 => uint256) public requestedLabForCase;
    mapping(bytes32 => uint256[]) private caseEvidence;

    uint256 public count;
    mapping(uint256 => Evidence) private evidences;
    mapping(uint256 => Docs) private docs;
    mapping(uint256 => CustodyRecord[]) private history;
    mapping(uint256 => StatusRecord[]) private statusHistory;
    mapping(uint256 => Report[]) private reports;
    mapping(uint256 => address) public pendingTo; // custody offer waiting to be accepted
    mapping(bytes32 => uint256) public hashToId;

    // ---------- Events ----------
    // The court of that location listens to these three (filter by courtId)
    event CaseOpened(
        uint256 indexed courtId,
        bytes32 indexed caseKey,
        address indexed investigator,
        string caseId,
        uint256 timestamp
    );
    event EvidenceApproved(
        uint256 indexed id,
        uint256 indexed courtId,
        address indexed collector,
        bytes32 caseKey,
        bytes32 fileHash,
        uint256 timestamp
    );
    event EvidenceSubmittedToCourt(
        uint256 indexed id,
        uint256 indexed courtId,
        address indexed by,
        uint256 timestamp
    );

    // For the admins' review queue
    event EvidenceSubmittedForReview(
        uint256 indexed id,
        address indexed collector,
        bytes32 indexed caseKey,
        bytes32 fileHash,
        uint256 timestamp
    );
    event AnalysisRequested(
        bytes32 indexed caseKey,
        uint256 indexed labId,
        address indexed by,
        string note,
        uint256 timestamp
    );

    event EvidenceRejected(
        uint256 indexed id,
        address indexed collector,
        string reason,
        uint256 timestamp
    );
    event CaseDecision(
        uint256 indexed courtId,
        bytes32 indexed caseKey,
        address indexed by,
        CaseStatus status,
        string note,
        uint256 timestamp
    );
    event AnalystAssigned(
        bytes32 indexed caseKey,
        address indexed analyst,
        uint256 timestamp
    );
    event AnalystRemoved(
        bytes32 indexed caseKey,
        address indexed analyst,
        uint256 timestamp
    );
    event CustodyOffered(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        string reason,
        uint256 timestamp
    );
    event CustodyOfferCancelled(
        uint256 indexed id,
        address indexed by,
        uint256 timestamp
    );
    event CustodyTransferred(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        Stage stage,
        uint256 timestamp
    );
    event AnalysisReportAdded(
        uint256 indexed id,
        address indexed analyst,
        bytes32 reportHash,
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

    modifier onlyAdmin() {
        require(msg.sender == address(admins), "Only the admin multisig");
        _;
    }

    constructor(address adminMultisig, address peopleRegistry) {
        admins = AdminMultisig(adminMultisig);
        people = PeopleRegistry(peopleRegistry);
    }

    // =====================================================
    // Internal helpers
    // =====================================================
    function _hasRole(
        address a,
        PeopleRegistry.Role r
    ) internal view returns (bool) {
        return people.activeRole(a) == r;
    }

    function _isCourtOf(
        address a,
        uint256 courtId
    ) internal view returns (bool) {
        return
            _hasRole(a, PeopleRegistry.Role.CourtOfficial) &&
            people.unitOf(a) == courtId;
    }

    function _isLead(address a, Case storage c) internal view returns (bool) {
        return
            a == c.leadInvestigator &&
            _hasRole(a, PeopleRegistry.Role.Investigator);
    }

    function _isAnalystOf(address a, bytes32 key) internal view returns (bool) {
        return isAnalyst[key][a] && _hasRole(a, PeopleRegistry.Role.Analyst);
    }

    /// Investigator or assigned analyst (people who can hold evidence)
    function _isParticipant(
        address a,
        bytes32 key
    ) internal view returns (bool) {
        return _isLead(a, cases[key]) || _isAnalystOf(a, key);
    }

    /// Who may see a case: its lead investigator, assigned analysts, the case's court
    function _canViewCase(address a, bytes32 key) internal view returns (bool) {
        Case storage c = cases[key];
        if (c.status == CaseStatus.None) return false;
        return
            _isLead(a, c) || _isAnalystOf(a, key) || _isCourtOf(a, c.courtId);
    }

    function _caseKey(Evidence storage e) internal view returns (bytes32) {
        return keccak256(bytes(e.caseId));
    }

    /// Approved evidence: investigator, analysts, the court. Pending or rejected: only the
    /// officer who registered it and the admins who review it.
    function _canSeeEvidence(
        address a,
        Evidence storage e
    ) internal view returns (bool) {
        bytes32 key = _caseKey(e);
        if (e.review == Review.Approved) return _canViewCase(a, key);
        return _isLead(a, cases[key]) || admins.isOwner(a);
    }

    function _viewable(uint256 id) internal view returns (Evidence storage e) {
        e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(_canSeeEvidence(msg.sender, e), "Not authorized for this case");
    }

    /// Evidence that can still move: approved, active, not yet submitted, case open
    function _movable(uint256 id) internal view returns (Evidence storage e) {
        e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.review == Review.Approved, "Evidence not approved");
        require(e.status == Status.Active, "Evidence is flagged or revoked");
        require(
            e.stage != Stage.SubmittedToCourt,
            "Already submitted to court"
        );
        require(
            cases[_caseKey(e)].status == CaseStatus.Open,
            "Case is not open"
        );
    }

    function _log(
        uint256 id,
        Action action,
        address from,
        address to,
        string memory reason
    ) internal {
        history[id].push(
            CustodyRecord(
                action,
                from,
                to,
                evidences[id].stage,
                reason,
                block.timestamp
            )
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

    function _decide(
        string memory caseId,
        CaseStatus to,
        string memory note
    ) internal {
        bytes32 key = keccak256(bytes(caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
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
    // Cases
    // =====================================================

    /// An approved investigator opens a case. The station comes from their profile and the
    /// court of that station's location is found automatically and notified.
    function openCase(string calldata caseId, string calldata title) external {
        require(
            _hasRole(msg.sender, PeopleRegistry.Role.Investigator),
            "Only an approved investigator"
        );
        require(bytes(caseId).length > 0, "Case ID required");
        uint256 stationId = people.unitOf(msg.sender);
        uint256 courtId = people.courtOfUnit(stationId);
        require(
            courtId != 0,
            "No court registered for this station's location"
        );
        bytes32 key = keccak256(bytes(caseId));
        require(cases[key].status == CaseStatus.None, "Case ID already used");

        Case storage c = cases[key];
        c.caseId = caseId;
        c.title = title;
        c.stationId = stationId;
        c.courtId = courtId;
        c.leadInvestigator = msg.sender;
        c.status = CaseStatus.Open;
        c.createdAt = block.timestamp;

        caseKeys.push(key);
        emit CaseOpened(courtId, key, msg.sender, caseId, block.timestamp);
    }

    /// Case decisions are recorded by the admin multisig; courts have read-only access.
    function rejectCase(
        string calldata caseId,
        string calldata reason
    ) external onlyAdmin {
        _decide(caseId, CaseStatus.Rejected, reason);
    }

    function closeCase(
        string calldata caseId,
        string calldata note
    ) external onlyAdmin {
        _decide(caseId, CaseStatus.Closed, note);
    }

    /// Lead investigator asks the admins to assign a forensic analyst from a lab
    function requestAnalysis(
        string calldata caseId,
        uint256 labId,
        string calldata note
    ) external {
        bytes32 key = keccak256(bytes(caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(_isLead(msg.sender, c), "Only lead investigator");
        (PeopleRegistry.UnitType t, , ) = people.unitInfo(labId);
        require(t == PeopleRegistry.UnitType.Lab, "Not a forensic lab");
        requestedLabForCase[key] = labId;
        emit AnalysisRequested(key, labId, msg.sender, note, block.timestamp);
    }

    /// Admins (multisig) assign an approved forensic analyst to the case
    function assignAnalyst(
        string calldata caseId,
        address analyst
    ) external onlyAdmin {
        bytes32 key = keccak256(bytes(caseId));
        require(cases[key].status == CaseStatus.Open, "Case is not open");
        uint256 requestedLabId = requestedLabForCase[key];
        require(requestedLabId != 0, "Analysis was not requested");
        require(
            _hasRole(analyst, PeopleRegistry.Role.Analyst),
            "Not an approved forensic analyst"
        );
        require(
            people.unitOf(analyst) == requestedLabId,
            "Analyst is not from requested lab"
        );
        require(!isAnalyst[key][analyst], "Already assigned");
        requestedLabForCase[key] = 0;
        isAnalyst[key][analyst] = true;
        analysts[key].push(analyst);
        emit AnalystAssigned(key, analyst, block.timestamp);
    }

    /// Admins remove an analyst. Blocked while the analyst still holds evidence on this case.
    function removeAnalyst(
        string calldata caseId,
        address analyst
    ) external onlyAdmin {
        bytes32 key = keccak256(bytes(caseId));
        require(isAnalyst[key][analyst], "Not assigned to this case");

        uint256[] storage ids = caseEvidence[key];
        for (uint256 i = 0; i < ids.length; i++) {
            Evidence storage ev = evidences[ids[i]];
            if (
                ev.review == Review.Approved &&
                ev.stage != Stage.SubmittedToCourt
            ) {
                require(
                    ev.currentHolder != analyst && pendingTo[ids[i]] != analyst,
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
        emit AnalystRemoved(key, analyst, block.timestamp);
    }

    // =====================================================
    // Evidence: registration and admin review
    // =====================================================

    /// The lead investigator submits evidence. It stays PENDING until the admins approve it.
    function registerEvidence(
        NewEvidence calldata input
    ) external returns (uint256 id) {
        bytes32 key = keccak256(bytes(input.caseId));
        Case storage c = cases[key];
        require(c.status == CaseStatus.Open, "Case is not open");
        require(_isLead(msg.sender, c), "Not lead investigator");
        require(input.fileHash != bytes32(0), "Empty hash");
        require(hashToId[input.fileHash] == 0, "Evidence already registered");
        require(
            input.docs.seizureMemoHash != bytes32(0),
            "Seizure memo hash required"
        );
        require(
            !input.docs.isElectronic ||
                input.docs.certificateHash != bytes32(0),
            "Electronic evidence needs its certificate hash"
        );
        require(
            input.docs.seizedAt != 0 && input.docs.seizedAt <= block.timestamp,
            "Invalid seizure time"
        );

        id = ++count;

        Evidence storage e = evidences[id];
        e.id = id;
        e.caseId = input.caseId;
        e.description = input.description;
        e.location = input.location;
        e.collectionMethod = input.collectionMethod;
        e.fileHash = input.fileHash;
        e.collector = msg.sender;
        e.currentHolder = msg.sender;
        e.createdAt = block.timestamp; // stage, status and review start at their first value

        Docs storage d = docs[id];
        d.seizedAt = input.docs.seizedAt;
        d.isElectronic = input.docs.isElectronic;
        d.seizureMemoHash = input.docs.seizureMemoHash;
        d.recordingHash = input.docs.recordingHash;
        d.certificateHash = input.docs.certificateHash;

        hashToId[input.fileHash] = id;
        caseEvidence[key].push(id);
        _log(
            id,
            Action.Registered,
            address(0),
            msg.sender,
            "Submitted for admin review"
        );

        emit EvidenceSubmittedForReview(
            id,
            msg.sender,
            key,
            input.fileHash,
            block.timestamp
        );
    }

    /// Admins (multisig) approve evidence after checking it. The case's court is notified.
    function approveEvidence(uint256 id) external onlyAdmin {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.review == Review.Pending, "Not pending review");
        bytes32 key = _caseKey(e);
        require(cases[key].status == CaseStatus.Open, "Case is not open");

        e.review = Review.Approved;
        _log(
            id,
            Action.Approved,
            msg.sender,
            e.collector,
            "Approved by admins"
        );
        emit EvidenceApproved(
            id,
            cases[key].courtId,
            e.collector,
            key,
            e.fileHash,
            block.timestamp
        );
    }

    /// Admins reject evidence. The officer can correct it and register it again.
    function rejectEvidence(
        uint256 id,
        string calldata reason
    ) external onlyAdmin {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.review == Review.Pending, "Not pending review");

        e.review = Review.Rejected;
        hashToId[e.fileHash] = 0;
        _log(id, Action.Rejected, msg.sender, e.collector, reason);
        emit EvidenceRejected(id, e.collector, reason, block.timestamp);
    }

    // =====================================================
    // Custody (every step is recorded)
    // =====================================================

    /// Step 1: the holder offers custody to the lead investigator or an assigned analyst
    function sendCustody(
        uint256 id,
        address to,
        string calldata reason
    ) external {
        Evidence storage e = _movable(id);
        require(
            msg.sender == e.currentHolder,
            "Only current holder can transfer"
        );
        require(pendingTo[id] == address(0), "Transfer already pending");
        require(to != address(0) && to != msg.sender, "Invalid recipient");
        bytes32 key = _caseKey(e);
        require(
            _isParticipant(msg.sender, key),
            "Sender is no longer on this case"
        );
        require(_isParticipant(to, key), "Recipient not on this case");

        pendingTo[id] = to;
        _log(id, Action.Offered, msg.sender, to, reason);
        emit CustodyOffered(id, msg.sender, to, reason, block.timestamp);
    }

    /// Step 2: the recipient accepts, and custody actually moves
    function acceptCustody(uint256 id) external {
        Evidence storage e = _movable(id);
        require(pendingTo[id] == msg.sender, "No transfer pending for you");
        bytes32 key = _caseKey(e);
        require(
            _isParticipant(msg.sender, key),
            "You are no longer on this case"
        );

        address from = e.currentHolder;
        e.currentHolder = msg.sender;
        e.stage = _isLead(msg.sender, cases[key])
            ? Stage.Collected
            : Stage.ForensicAnalysis;
        pendingTo[id] = address(0);
        _log(id, Action.Accepted, from, msg.sender, "Custody accepted");
        emit CustodyTransferred(id, from, msg.sender, e.stage, block.timestamp);
    }

    function cancelCustodyOffer(uint256 id) external {
        Evidence storage e = _movable(id);
        require(msg.sender == e.currentHolder, "Only current holder");
        require(pendingTo[id] != address(0), "No transfer pending");
        address to = pendingTo[id];
        pendingTo[id] = address(0);
        _log(id, Action.OfferCancelled, msg.sender, to, "Offer cancelled");
        emit CustodyOfferCancelled(id, msg.sender, block.timestamp);
    }

    /// Admins (multisig) move evidence away from a holder who is no longer active on the case
    function forceReassign(
        uint256 id,
        address newHolder,
        string calldata reason
    ) external onlyAdmin {
        Evidence storage e = _movable(id);
        bytes32 key = _caseKey(e);
        require(
            !_isParticipant(e.currentHolder, key),
            "Current holder is still active on the case"
        );
        require(_isParticipant(newHolder, key), "Recipient not on this case");

        address from = e.currentHolder;
        e.currentHolder = newHolder;
        e.stage = _isLead(newHolder, cases[key])
            ? Stage.Collected
            : Stage.ForensicAnalysis;
        pendingTo[id] = address(0);
        _log(id, Action.Reassigned, from, newHolder, reason);
        emit CustodyTransferred(id, from, newHolder, e.stage, block.timestamp);
    }

    /// The holder formally submits the evidence to the court. The court is notified.
    function submitToCourt(uint256 id, string calldata note) external {
        Evidence storage e = _movable(id);
        require(msg.sender == e.currentHolder, "Only current holder");
        require(pendingTo[id] == address(0), "Transfer pending");
        bytes32 key = _caseKey(e);
        require(_isParticipant(msg.sender, key), "Not on this case");

        e.stage = Stage.SubmittedToCourt;
        _log(id, Action.SubmittedToCourt, msg.sender, msg.sender, note);
        emit EvidenceSubmittedToCourt(
            id,
            cases[key].courtId,
            msg.sender,
            block.timestamp
        );
    }

    // =====================================================
    // Forensic reports, audit, flags
    // =====================================================

    /// An assigned analyst records the hash of their examination report
    function addAnalysisReport(
        uint256 id,
        bytes32 reportHash,
        string calldata note
    ) external {
        Evidence storage e = _viewable(id);
        require(e.review == Review.Approved, "Evidence not approved");
        require(
            _isAnalystOf(msg.sender, _caseKey(e)),
            "Only an assigned analyst"
        );
        require(reportHash != bytes32(0), "Empty hash");

        Report storage r = reports[id].push();
        r.analyst = msg.sender;
        r.reportHash = reportHash;
        r.note = note;
        r.timestamp = block.timestamp;
        emit AnalysisReportAdded(id, msg.sender, reportHash, block.timestamp);
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

    /// Case participants can dispute approved evidence. It is frozen until admins resolve it.
    function flagEvidence(uint256 id, string calldata reason) external {
        Evidence storage e = _viewable(id);
        require(e.review == Review.Approved, "Evidence not approved");
        require(e.status == Status.Active, "Evidence is not active");
        require(
            _isParticipant(msg.sender, _caseKey(e)),
            "Only case participants can flag"
        );
        _setStatus(id, Status.Flagged, reason);
    }

    /// Only the admin multisig clears a flag
    function resolveFlag(uint256 id, string calldata note) external onlyAdmin {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.status == Status.Flagged, "Evidence is not flagged");
        _setStatus(id, Status.Active, note);
    }

    /// Only the admin multisig can permanently revoke. The record stays on the chain.
    function revokeEvidence(
        uint256 id,
        string calldata reason
    ) external onlyAdmin {
        Evidence storage e = evidences[id];
        require(e.id != 0, "Evidence not found");
        require(e.status != Status.Revoked, "Already revoked");
        _setStatus(id, Status.Revoked, reason);
    }

    // =====================================================
    // Read functions
    // =====================================================

    function verify(uint256 id, bytes32 fileHash) external view returns (bool) {
        return _viewable(id).fileHash == fileHash;
    }

    function getEvidence(uint256 id) external view returns (Evidence memory) {
        return _viewable(id);
    }

    function getEvidenceDocs(uint256 id) external view returns (Docs memory) {
        _viewable(id);
        return docs[id];
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

    function getAnalysisReports(
        uint256 id
    ) external view returns (Report[] memory) {
        _viewable(id);
        return reports[id];
    }

    function getCase(
        string calldata caseId
    ) external view returns (Case memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(
            _canViewCase(msg.sender, key) ||
                (admins.isOwner(msg.sender) &&
                    cases[key].status != CaseStatus.None),
            "Not authorized for this case"
        );
        return cases[key];
    }

    function getAnalysts(
        string calldata caseId
    ) external view returns (address[] memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(
            _canViewCase(msg.sender, key) ||
                (admins.isOwner(msg.sender) &&
                    cases[key].status != CaseStatus.None),
            "Not authorized for this case"
        );
        return analysts[key];
    }

    /// Evidence of a case that the caller may see (admins see only pending or rejected items)
    function getCaseEvidence(
        string calldata caseId
    ) external view returns (Evidence[] memory) {
        bytes32 key = keccak256(bytes(caseId));
        require(
            _canViewCase(msg.sender, key) ||
                (admins.isOwner(msg.sender) &&
                    cases[key].status != CaseStatus.None),
            "Not authorized for this case"
        );
        uint256[] storage ids = caseEvidence[key];
        uint256 n = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (_canSeeEvidence(msg.sender, evidences[ids[i]])) n++;
        }
        Evidence[] memory list = new Evidence[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (_canSeeEvidence(msg.sender, evidences[ids[i]])) {
                list[k] = evidences[ids[i]];
                k++;
            }
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

    /// IDs of approved evidence the caller currently holds
    function getMyHeldEvidence() external view returns (uint256[] memory) {
        uint256 n = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (
                evidences[i].review == Review.Approved &&
                evidences[i].currentHolder == msg.sender
            ) n++;
        }
        uint256[] memory ids = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (
                evidences[i].review == Review.Approved &&
                evidences[i].currentHolder == msg.sender
            ) {
                ids[k] = i;
                k++;
            }
        }
        return ids;
    }

    /// Admin review queue: evidence waiting for a decision
    function getPendingEvidence() external view returns (uint256[] memory) {
        require(admins.isOwner(msg.sender), "Admins only");
        uint256 n = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (evidences[i].review == Review.Pending) n++;
        }
        uint256[] memory ids = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = 1; i <= count; i++) {
            if (evidences[i].review == Review.Pending) {
                ids[k] = i;
                k++;
            }
        }
        return ids;
    }

    // ---------- Shortcuts used by the backend and frontend ----------

    /// "Admin" for an admin (multisig owner), otherwise the profile role, "Pending", "Suspended" or "None"
    function getUserRole(address a) external view returns (string memory) {
        if (admins.isOwner(a)) return "Admin";
        return people.roleName(a);
    }

    /// The court a court official works for (0 if the address is not an active court official)
    function officialCourt(address a) external view returns (uint256) {
        return
            _hasRole(a, PeopleRegistry.Role.CourtOfficial)
                ? people.unitOf(a)
                : 0;
    }

    function courtName(uint256 courtId) external view returns (string memory) {
        return people.unitName(courtId);
    }
}
