// @ts-check
import { getDefaultConfig } from "expo/metro-config";

const config = getDefaultConfig(import.meta.dirname);
// expo-sqlite on web ships a WebAssembly SQLite; Metro must treat it as an asset.
config.resolver.assetExts.push("wasm");
export default config;
