import { wiseBizVitest } from "@wise-biz/testing";
import { mergeConfig } from "vitest/config";

// Components render through react-native-web in jsdom: the same path the web POS, Electron terminal and gallery use.
// Native rendering is covered by the gallery on an Android device or emulator.
const shared = mergeConfig(
  wiseBizVitest({
    coverage: { lines: 90, functions: 90, branches: 85, statements: 90 },
  }),
  {
    resolve: {
      alias: [
        { find: /^react-native$/, replacement: "react-native-web" },
        {
          find: /^react-native-svg$/,
          replacement: `${import.meta.dirname}/test/stubs/react-native-svg.tsx`,
        },
      ],
    },
    test: {
      environment: "jsdom",
      setupFiles: ["test/setup.ts"],
      // Tabler is inlined so Vite applies the react-native and react-native-svg aliases; loaded natively, its
      // react-native-svg import reaches react-native source that Node cannot parse.
      server: { deps: { inline: [/@tabler\/icons-react-native/] } },
      // Components are .tsx: count them, not only the .ts helpers the shared config measures.
      coverage: {
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.d.ts", "src/**/*.test.{ts,tsx}"],
      },
    },
  },
);

export default mergeConfig(shared, {
  test: {
    // Timing tests run after the unit suite, so other workers do not skew the theme-switch budget.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.{ts,tsx}"], sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: { name: "perf", include: ["test/**/*.test.{ts,tsx}"], sequence: { groupOrder: 2 } },
      },
    ],
  },
});
