import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
} from "@tabler/icons-react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { ABSOLUTE_FILL } from "../theme/layout.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { Icon as TablerIcon } from "@tabler/icons-react-native";
import type { ReactNode } from "react";

export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  readonly message: string;
  readonly tone: ToastTone;
  /** ms before it dismisses. Default 4000. */
  readonly duration?: number | undefined;
}

export interface ToastApi {
  readonly show: (input: ToastInput) => void;
}

interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

export interface ToastProviderProps {
  readonly children?: ReactNode;
}

const DEFAULT_DURATION_MS = 4000;
const MAX_STACK = 3;

const ICONS: Readonly<Record<ToastTone, TablerIcon>> = {
  success: IconCircleCheck,
  info: IconInfoCircle,
  warning: IconAlertTriangle,
  danger: IconCircleX,
};

const ToastContext = createContext<ToastApi | null>(null);

const useRegionStyles = createStyles((t) => ({
  region: {
    ...ABSOLUTE_FILL,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: t.space[4],
    gap: t.space[2],
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: t.space[3],
    minHeight: t.target.min,
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[3],
    borderRadius: t.radius.card,
  },
}));

function ToastView({ item }: { readonly item: ToastItem }) {
  const theme = useTheme();
  const styles = useRegionStyles();
  const colors = theme.component.badge[item.tone];
  const danger = item.tone === "danger";
  return (
    <View
      role={danger ? "alert" : "status"}
      aria-live={danger ? "assertive" : "polite"}
      style={[styles.toast, { backgroundColor: colors.bg }]}
    >
      <Icon icon={ICONS[item.tone]} color={colors.fg} />
      <Text variant="label" style={{ color: colors.fg, flexShrink: 1 }}>
        {item.message}
      </Text>
    </View>
  );
}

/** Hosts toasts and their timers. Mount once near the root. */
export function ToastProvider({ children }: ToastProviderProps) {
  const styles = useRegionStyles();
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  // Timers of toasts that left the stack (overflow) are cleared here, so nothing fires for a hidden toast.
  useEffect(() => {
    const live = new Set(items.map((item) => item.id));
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
  }, [items]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const show = useCallback(
    ({ message, tone, duration = DEFAULT_DURATION_MS }: ToastInput): void => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((previous) => [...previous, { id, message, tone }].slice(-MAX_STACK));
      timers.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, duration),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="box-none" style={styles.region}>
        {items.map((item) => (
          <ToastView key={item.id} item={item} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

/** Show a toast. Throws outside ToastProvider. */
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("useToast must be used inside <ToastProvider>.");
  return value;
}
