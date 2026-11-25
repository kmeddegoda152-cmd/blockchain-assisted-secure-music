
import { buildModule } from
    "@nomicfoundation/hardhat-ignition/modules";

export default buildModule(
    "MusicAccessModule",
    (m) => {

        const musicAccess = m.contract(
            "MusicAccessControl"
        );

        return { musicAccess };
    }
);
