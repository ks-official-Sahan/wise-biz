// @ts-check
import { getDefaultConfig } from "expo/metro-config";

// Expo's default config already watches the monorepo root and resolves workspace packages through their
// symlinks. @wise-biz/* ship TypeScript source, which Metro transforms like app code, so no overrides are needed.
export default getDefaultConfig(import.meta.dirname);
