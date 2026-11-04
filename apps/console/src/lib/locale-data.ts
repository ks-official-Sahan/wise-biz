/**
 * Short, curated pick lists for setup forms. Full ISO lists come later from the localization module; the API validates
 * any ISO code, these are only defaults that keep the first-run form fast. Demo market first (Sri Lanka).
 */
export const COUNTRIES: readonly {
  value: string;
  label: string;
  currency: string;
  timezone: string;
}[] = [
  { value: "LK", label: "Sri Lanka", currency: "LKR", timezone: "Asia/Colombo" },
  { value: "IN", label: "India", currency: "INR", timezone: "Asia/Kolkata" },
  { value: "MV", label: "Maldives", currency: "MVR", timezone: "Indian/Maldives" },
  { value: "AE", label: "United Arab Emirates", currency: "AED", timezone: "Asia/Dubai" },
  { value: "SG", label: "Singapore", currency: "SGD", timezone: "Asia/Singapore" },
  { value: "AU", label: "Australia", currency: "AUD", timezone: "Australia/Sydney" },
  { value: "GB", label: "United Kingdom", currency: "GBP", timezone: "Europe/London" },
  { value: "US", label: "United States", currency: "USD", timezone: "America/New_York" },
];

export const CURRENCIES = ["LKR", "INR", "MVR", "AED", "SGD", "AUD", "GBP", "USD", "EUR"] as const;

/** The browser's zone, when it is a real IANA zone; else Colombo. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Colombo";
  } catch {
    return "Asia/Colombo";
  }
}

/** Every IANA zone the runtime knows (modern browsers and Node 24), with the browser zone first. */
export function timezones(): string[] {
  const own = browserTimezone();
  let all: string[];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = COUNTRIES.map((c) => c.timezone);
  }
  return [own, ...all.filter((z) => z !== own)];
}
