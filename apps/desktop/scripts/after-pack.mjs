// Flips the Electron fuses on the packaged executable: the binary itself refuses the escape hatches a hardened terminal
// must not have (run as Node, NODE_OPTIONS, the Node inspector, loading app code from outside the asar).
import path from "node:path";

import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

/** @param {import("electron-builder").AfterPackContext} context */
export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const name = packager.appInfo.productFilename;
  const executable =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${name}.app`, "Contents", "MacOS", name)
      : electronPlatformName === "win32"
        ? path.join(appOutDir, `${name}.exe`)
        : path.join(appOutDir, packager.executableName);

  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === "darwin",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
