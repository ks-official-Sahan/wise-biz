// @ts-check
import { next } from "@wise-biz/config/eslint/next";

export default [
  { ignores: [".next/**", "next-env.d.ts", "test-results/**", "playwright-report/**"] },
  ...next({ root: import.meta.dirname }),
  {
    // App Router file conventions under src/app must default-export their component.
    files: [
      "src/app/**/{page,layout,loading,error,not-found,template,default,route,global-error}.tsx",
      "src/proxy.ts",
    ],
    rules: { "import-x/no-default-export": "off" },
  },
];
