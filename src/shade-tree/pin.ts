export const SHADE_TREE_VERSION = "0.4.0";
export const SHADE_TREE_RELEASE_TAG = "v0.4.0";
export const SHADE_TREE_RELEASE_COMMIT =
  "db074e4e75daf87b50fd52bda5378c9d04ce6c4d";
export const SHADE_TREE_REPOSITORY =
  "https://github.com/dmarzzz/shade-tree-node";

export interface ShadeTreeHostPin {
  asset: string;
  sha256: string;
}

export function shadeTreeHostPin(
  platform: NodeJS.Platform,
  arch: string,
): ShadeTreeHostPin | undefined {
  if (platform === "linux" && arch === "arm64") {
    return {
      asset: "shade-tree-0.4.0-aarch64-unknown-linux-gnu-live",
      sha256: "17432ff1d53138d0535b4940a0ee0dcde7421d09fe614533225aa3c12bee1196",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      asset: "shade-tree-0.4.0-aarch64-apple-darwin-live",
      sha256: "9002f9bb1b834cfabcb761ed6ce6b678e10f6690e7f74e7f89ef54a33f25fb3f",
    };
  }
  return undefined;
}
