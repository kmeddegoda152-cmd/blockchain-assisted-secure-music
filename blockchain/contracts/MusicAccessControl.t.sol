
 // SPDX-License-Identifier: MIT
 pragma solidity ^0.8.24;

 import "./MusicAccessControl.sol";

 // A separate account for testing unauthorized actions
 contract TestCaller {

     function register(
         MusicAccessControl access,
         bytes32 trackId,
         bytes32 fileHash
     ) external {
         access.registerTrack(trackId, fileHash);
     }

     function grant(
         MusicAccessControl access,
         bytes32 trackId,
         address collaborator
     ) external {
         access.grantAccess(trackId, collaborator);
     }
 }

 contract MusicAccessControlTest {

     // TEST 1: Artist registers a track
     function testRegistrationAndOwnerAccess() public {

         MusicAccessControl access =
             new MusicAccessControl();

         bytes32 trackId = keccak256("track-001");
         bytes32 fileHash = sha256(bytes("test audio"));

         access.registerTrack(trackId, fileHash);

         require(
             access.checkAccess(trackId, address(this)),
             "Artist should have access"
         );
     }

     // TEST 2: Grant and revoke permissions
     function testGrantAndRevoke() public {

         MusicAccessControl access =
             new MusicAccessControl();

         bytes32 trackId = keccak256("track-002");
         bytes32 fileHash = sha256(bytes("test audio"));

         address collaborator = address(0xBEEF);

         access.registerTrack(trackId, fileHash);

         require(
             !access.checkAccess(trackId, collaborator),
             "Should initially be denied"
         );

         access.grantAccess(trackId, collaborator);

         require(
             access.checkAccess(trackId, collaborator),
             "Access grant failed"
         );

         access.revokeAccess(trackId, collaborator);

         require(
             !access.checkAccess(trackId, collaborator),
             "Access revocation failed"
         );
     }

     // TEST 3: Non-owner cannot grant permission
     function testOtherCallerCannotGrant() public {

         MusicAccessControl access =
             new MusicAccessControl();

         bytes32 trackId = keccak256("track-003");

         access.registerTrack(
             trackId,
             sha256(bytes("test audio"))
         );

         TestCaller outsider = new TestCaller();

         bool rejected = false;

         try outsider.grant(
             access,
             trackId,
             address(0xBEEF)
         ) {
             rejected = false;
         } catch {
             rejected = true;
         }

         require(
             rejected,
             "Non-owner should not grant access"
         );
     }

     // TEST 4: Non-artist cannot register a track
     function testNonArtistCannotRegister() public {

         MusicAccessControl access =
             new MusicAccessControl();

         TestCaller outsider = new TestCaller();

         bool rejected = false;

         try outsider.register(
             access,
             keccak256("track-004"),
             sha256(bytes("test audio"))
         ) {
             rejected = false;
         } catch {
             rejected = true;
         }

         require(
             rejected,
             "Non-artist should not register"
         );
     }
 }
