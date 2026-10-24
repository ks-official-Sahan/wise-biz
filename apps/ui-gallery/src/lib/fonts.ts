import { Geist_400Regular, Geist_500Medium } from "@expo-google-fonts/geist";
import { GeistMono_400Regular, GeistMono_500Medium } from "@expo-google-fonts/geist-mono";
import { useFonts } from "expo-font";

/**
 * Family names are the ones @wise-biz/theme uses (BODY_FONT_FAMILY, NUMERIC_FONT_FAMILY). Both weights of a
 * family are declared in one call, so the browser picks 500 for fontWeight "500" (expo-font docs: web weights).
 */
const FONTS = [
  {
    fontFamily: "Geist",
    fontDefinitions: [
      { path: Geist_400Regular, weight: 400 },
      { path: Geist_500Medium, weight: 500 },
    ],
  },
  {
    fontFamily: "Geist Mono",
    fontDefinitions: [
      { path: GeistMono_400Regular, weight: 400 },
      { path: GeistMono_500Medium, weight: 500 },
    ],
  },
];

/** True once the fonts can render. A failed load still resolves so the app never sticks on the splash. */
export function useGalleryFonts(): boolean {
  const [loaded, error] = useFonts(FONTS);
  return loaded || error !== null;
}
