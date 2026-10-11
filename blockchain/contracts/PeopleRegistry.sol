// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AdminMultisig.sol";

/// Courts, police stations, forensic labs and the profiles of the people who work in them.
/// No personal data is stored: a profile holds only a hash of the details kept off-chain.
contract PeopleRegistry {
    AdminMultisig public immutable admins;

    enum UnitType {
        None,
        Station,
        Lab,
        Court
    }
    enum Role {
        None,
        Investigator,
        Analyst,
        CourtOfficial
    }
    enum ProfileStatus {
        None,
        Pending,
        Active,
        Rejected,
        Suspended
    }

    struct Unit {
        UnitType unitType;
        string name;
        string location; // district or town
    }

    struct Profile {
        Role role;
        uint256 unitId;
        bytes32 detailsHash; // hash of the details/ID documents kept off-chain
        ProfileStatus status;
        uint256 requestedAt;
        uint256 decidedAt;
    }

    uint256 public unitCount;
    mapping(uint256 => Unit) private units;
    mapping(bytes32 => uint256) private courtOfLocation; // keccak256(location) => court unit id
    mapping(address => Profile) private profiles;
    address[] private applicants;

    event UnitRegistered(
        uint256 indexed id,
        UnitType unitType,
        string name,
        string location
    );
    event ProfileRequested(
        address indexed who,
        Role role,
        uint256 indexed unitId,
        bytes32 detailsHash
    );
    event ProfileDecided(
        address indexed who,
        ProfileStatus status,
        string note
    );

    modifier onlyAdmin() {
        require(msg.sender == address(admins), "Only the admin multisig");
        _;
    }

    constructor(address adminMultisig) {
        admins = AdminMultisig(adminMultisig);
    }

    // =====================================================
    // Admin: courts, stations, labs (batch)
    // =====================================================

    function registerUnits(
        UnitType t,
        string[] calldata names,
        string[] calldata locs
    ) external onlyAdmin {
        require(t != UnitType.None, "Bad unit type");
        require(names.length > 0 && names.length == locs.length, "Bad input");
        for (uint256 i = 0; i < names.length; i++) {
            require(
                bytes(names[i]).length > 0 && bytes(locs[i]).length > 0,
                "Name and location required"
            );
            uint256 id = ++unitCount;
            Unit storage u = units[id];
            u.unitType = t;
            u.name = names[i];
            u.location = locs[i];
            if (t == UnitType.Court) {
                bytes32 lk = keccak256(bytes(locs[i]));
                require(
                    courtOfLocation[lk] == 0,
                    "Location already has a court"
                );
                courtOfLocation[lk] = id;
            }
            emit UnitRegistered(id, t, names[i], locs[i]);
        }
    }

    // =====================================================
    // Profiles
    // =====================================================

    /// Anyone (except an admin) asks for a role at a unit. Admins review the off-chain details
    /// and compare their hash with detailsHash before approving.
    function requestProfile(
        Role role,
        uint256 unitId,
        bytes32 detailsHash
    ) external {
        require(
            !admins.isOwner(msg.sender),
            "Admins cannot hold operational roles"
        );
        require(role != Role.None && detailsHash != bytes32(0), "Bad request");
        Profile storage p = profiles[msg.sender];
        require(
            p.status == ProfileStatus.None ||
                p.status == ProfileStatus.Rejected,
            "Profile already submitted"
        );
        UnitType need = role == Role.Investigator
            ? UnitType.Station
            : (role == Role.Analyst ? UnitType.Lab : UnitType.Court);
        require(units[unitId].unitType == need, "Wrong unit for this role");

        if (p.status == ProfileStatus.None) applicants.push(msg.sender);
        p.role = role;
        p.unitId = unitId;
        p.detailsHash = detailsHash;
        p.status = ProfileStatus.Pending;
        p.requestedAt = block.timestamp;
        p.decidedAt = 0;
        emit ProfileRequested(msg.sender, role, unitId, detailsHash);
    }

    function approveProfile(address who) external onlyAdmin {
        Profile storage p = profiles[who];
        require(p.status == ProfileStatus.Pending, "Not pending");
        p.status = ProfileStatus.Active;
        p.decidedAt = block.timestamp;
        emit ProfileDecided(who, ProfileStatus.Active, "Approved");
    }

    function rejectProfile(
        address who,
        string calldata reason
    ) external onlyAdmin {
        Profile storage p = profiles[who];
        require(p.status == ProfileStatus.Pending, "Not pending");
        p.status = ProfileStatus.Rejected;
        p.decidedAt = block.timestamp;
        emit ProfileDecided(who, ProfileStatus.Rejected, reason);
    }

    function suspendProfile(
        address who,
        string calldata reason
    ) external onlyAdmin {
        Profile storage p = profiles[who];
        require(p.status == ProfileStatus.Active, "Not active");
        p.status = ProfileStatus.Suspended;
        p.decidedAt = block.timestamp;
        emit ProfileDecided(who, ProfileStatus.Suspended, reason);
    }

    function reinstateProfile(address who) external onlyAdmin {
        Profile storage p = profiles[who];
        require(p.status == ProfileStatus.Suspended, "Not suspended");
        p.status = ProfileStatus.Active;
        p.decidedAt = block.timestamp;
        emit ProfileDecided(who, ProfileStatus.Active, "Reinstated");
    }

    // =====================================================
    // Read functions
    // =====================================================

    function profileOf(address who) external view returns (Profile memory) {
        return profiles[who];
    }

    /// The role of an ACTIVE profile (None if pending, rejected or suspended)
    function activeRole(address who) external view returns (Role) {
        Profile storage p = profiles[who];
        return p.status == ProfileStatus.Active ? p.role : Role.None;
    }

    function unitOf(address who) external view returns (uint256) {
        return profiles[who].unitId;
    }

    function unitInfo(
        uint256 id
    )
        external
        view
        returns (UnitType unitType, string memory name, string memory location)
    {
        Unit storage u = units[id];
        return (u.unitType, u.name, u.location);
    }

    function unitName(uint256 id) external view returns (string memory) {
        return units[id].name;
    }

    /// The court that serves a unit's location (0 if none)
    function courtOfUnit(uint256 unitId) external view returns (uint256) {
        return courtOfLocation[keccak256(bytes(units[unitId].location))];
    }

    function courtForLocation(
        string calldata location
    ) external view returns (uint256 id, string memory name) {
        id = courtOfLocation[keccak256(bytes(location))];
        name = units[id].name;
    }

    /// All units of a type (fill dropdowns with this)
    function getUnits(
        UnitType t
    )
        external
        view
        returns (
            uint256[] memory ids,
            string[] memory names,
            string[] memory locs
        )
    {
        return _collect(t, false, bytes32(0));
    }

    /// Units of a type in one location (for example the stations of a district)
    function getUnitsAt(
        UnitType t,
        string calldata location
    )
        external
        view
        returns (
            uint256[] memory ids,
            string[] memory names,
            string[] memory locs
        )
    {
        return _collect(t, true, keccak256(bytes(location)));
    }

    /// Admin review queue: addresses whose profile is waiting for a decision
    function pendingProfiles() external view returns (address[] memory) {
        require(admins.isOwner(msg.sender), "Admins only");
        uint256 n = 0;
        for (uint256 i = 0; i < applicants.length; i++) {
            if (profiles[applicants[i]].status == ProfileStatus.Pending) n++;
        }
        address[] memory list = new address[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < applicants.length; i++) {
            if (profiles[applicants[i]].status == ProfileStatus.Pending) {
                list[k] = applicants[i];
                k++;
            }
        }
        return list;
    }

    function roleName(address who) external view returns (string memory) {
        Profile storage p = profiles[who];
        if (p.status == ProfileStatus.Pending) return "Pending";
        if (p.status == ProfileStatus.Suspended) return "Suspended";
        if (p.status == ProfileStatus.Active) {
            if (p.role == Role.Investigator) return "Investigator";
            if (p.role == Role.Analyst) return "Forensic Analyst";
            if (p.role == Role.CourtOfficial) return "Court Official";
        }
        return "None";
    }

    function _collect(
        UnitType t,
        bool filter,
        bytes32 locKey
    )
        internal
        view
        returns (
            uint256[] memory ids,
            string[] memory names,
            string[] memory locs
        )
    {
        uint256 n = 0;
        for (uint256 i = 1; i <= unitCount; i++) {
            if (
                units[i].unitType == t &&
                (!filter || keccak256(bytes(units[i].location)) == locKey)
            ) n++;
        }
        ids = new uint256[](n);
        names = new string[](n);
        locs = new string[](n);
        uint256 k = 0;
        for (uint256 i = 1; i <= unitCount; i++) {
            if (
                units[i].unitType == t &&
                (!filter || keccak256(bytes(units[i].location)) == locKey)
            ) {
                ids[k] = i;
                names[k] = units[i].name;
                locs[k] = units[i].location;
                k++;
            }
        }
    }
}
