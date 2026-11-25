// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract MusicAccessControl is AccessControl {

    // Role assigned to authorized artists
    bytes32 public constant ARTIST_ROLE =
        keccak256("ARTIST_ROLE");

    // Information stored for each music track
    struct Track {
        address artist;
        bytes32 fileHash;
        bool exists;
    }

    // Stores registered tracks
    mapping(bytes32 => Track) public tracks;

    // Stores access permissions for collaborators
    mapping(bytes32 => mapping(address => bool))
        private permissions;

    // Blockchain events
    event TrackRegistered(
        bytes32 indexed trackId,
        address indexed artist,
        bytes32 fileHash
    );

    event AccessGranted(
        bytes32 indexed trackId,
        address indexed collaborator
    );

    event AccessRevoked(
        bytes32 indexed trackId,
        address indexed collaborator
    );

    // Give the deploying wallet administrator
    // and artist roles
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ARTIST_ROLE, msg.sender);
    }

    // Only the track's owner can manage its access
    modifier onlyTrackArtist(bytes32 trackId) {
        require(
            tracks[trackId].exists,
            "Track does not exist"
        );

        require(
            tracks[trackId].artist == msg.sender,
            "Not the track owner"
        );

        _;
    }

    // Register a new music track
    function registerTrack(
        bytes32 trackId,
        bytes32 fileHash
    ) external onlyRole(ARTIST_ROLE) {

        require(trackId != bytes32(0), "Invalid track ID");
        require(fileHash != bytes32(0), "Invalid file hash");
        require(!tracks[trackId].exists, "Track already exists");

        tracks[trackId] = Track({
            artist: msg.sender,
            fileHash: fileHash,
            exists: true
        });

        emit TrackRegistered(
            trackId,
            msg.sender,
            fileHash
        );
    }

    // Grant a collaborator access to a track
    function grantAccess(
        bytes32 trackId,
        address collaborator
    ) external onlyTrackArtist(trackId) {

        require(
            collaborator != address(0),
            "Invalid collaborator"
        );

        permissions[trackId][collaborator] = true;

        emit AccessGranted(
            trackId,
            collaborator
        );
    }

    // Revoke a collaborator's access
    function revokeAccess(
        bytes32 trackId,
        address collaborator
    ) external onlyTrackArtist(trackId) {

        permissions[trackId][collaborator] = false;

        emit AccessRevoked(
            trackId,
            collaborator
        );
    }

    // Check whether a user can access a track
    function checkAccess(
        bytes32 trackId,
        address user
    ) external view returns (bool) {

        if (!tracks[trackId].exists) {
            return false;
        }

        return tracks[trackId].artist == user
            || permissions[trackId][user];
    }
}
