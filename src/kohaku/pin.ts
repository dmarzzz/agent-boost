import pin from "./kohaku-pin.json" with { type: "json" };

export const KOHAKU_REPOSITORY = pin.repository;
export const KOHAKU_COMMIT = pin.commit;
export const KOHAKU_VERSION = pin.version;
export const KOHAKU_PROVENANCE_FILE = ".agent-boost-install.json";

export interface KohakuInstallProvenance {
  schemaVersion: 1;
  repository: string;
  commit: string;
  version: string;
  platform: string;
  arch: string;
  installedAt: string;
  sha256: {
    packageLock: string;
    launcher: string;
    bundle: string;
  };
}
