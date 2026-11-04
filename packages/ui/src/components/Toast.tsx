import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  IconX,
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
import { IconButton } from "./IconButton.tsx";
import { Text } from "./Text.tsx";

import type { Icon as TablerIcon } from "@tabler/icons-react-native";
import type { ReactNode } from "react";

export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  readonly message: string;
  readonly tone: ToastTone;
  /** ms before it dismisses. Default 4000; danger toasts stay until dismissed unless a duration is given. */
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

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | undefined;
  /** Epoch ms when it fires; undefined while paused. */
  deadline: number | undefined;
  remaining: number;
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
  stack: { alignSelf: "stretch", gap: t.space[2] },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: t.space[3],
    minHeight: t.target.min,
    paddingLeft: t.space[4],
    paddingRight: t.space[1],
    paddingVertical: t.space[1],
    borderRadius: t.radius.card,
  },
}));

function ToastView({
  item,
  onDismiss,
}: {
  readonly item: ToastItem;
  readonly onDismiss: (id: number) => void;
}) {
  const theme = useTheme();
  const styles = useRegionStyles();
  const colors = theme.component.badge[item.tone];
  return (
    <View
      role={item.tone === "danger" ? "alert" : undefined}
      style={[styles.toast, { backgroundColor: colors.bg }]}
    >
      <Icon icon={ICONS[item.tone]} color={colors.fg} />
      <Text variant="label" style={{ color: colors.fg, flex: 1 }}>
        {item.message}
      </Text>
      <IconButton
        icon={IconX}
        accessibilityLabel="Dismiss notification"
        onPress={() => {
          onDismiss(item.id);
        }}
      />
    </View>
  );
}

/**
 * Hosts toasts and their timers. Mount once near the root. The live region is always mounted so screen readers
 * announce inserted messages (WCAG 4.1.3). Timers pause while the pointer is over the stack (WCAG 2.2.1).
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const styles = useRegionStyles();
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ToastTimer>());
  const paused = useRef(false);

  const dismiss = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (timer?.handle !== undefined) clearTimeout(timer.handle);
    timers.current.delete(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const arm = useCallback(
    (id: number, timer: ToastTimer): void => {
      timer.deadline = Date.now() + timer.remaining;
      timer.handle = setTimeout(() => {
        dismiss(id);
      }, timer.remaining);
    },
    [dismiss],
  );

  const pause = useCallback((): void => {
    paused.current = true;
    const now = Date.now();
    for (const timer of timers.current.values()) {
      if (timer.handle === undefined || timer.deadline === undefined) continue;
      clearTimeout(timer.handle);
      timer.remaining = Math.max(0, timer.deadline - now);
      timer.handle = undefined;
      timer.deadline = undefined;
    }
  }, []);

  const resume = useCallback((): void => {
    paused.current = false;
    for (const [id, timer] of timers.current) {
      if (timer.handle === undefined) arm(id, timer);
    }
  }, [arm]);

  // Timers of toasts that left the stack (overflow) are cleared here, so nothing fires for a hidden toast.
  useEffect(() => {
    const live = new Set(items.map((item) => item.id));
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        if (timer.handle !== undefined) clearTimeout(timer.handle);
        timers.current.delete(id);
      }
    }
  }, [items]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        if (timer.handle !== undefined) clearTimeout(timer.handle);
      }
      pending.clear();
    };
  }, []);

  const show = useCallback(
    ({ message, tone, duration }: ToastInput): void => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((previous) => [...previous, { id, message, tone }].slice(-MAX_STACK));
      const ms = duration ?? (tone === "danger" ? undefined : DEFAULT_DURATION_MS);
      if (ms === undefined) return;
      const timer: ToastTimer = { handle: undefined, deadline: undefined, remaining: ms };
      timers.current.set(id, timer);
      if (!paused.current) arm(id, timer);
    },
    [arm],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="box-none" style={styles.region}>
        <View
          role="status"
          aria-live="polite"
          onPointerEnter={pause}
          onPointerLeave={resume}
          style={styles.stack}
        >
          {items.map((item) => (
            <ToastView key={item.id} item={item} onDismiss={dismiss} />
          ))}
        </View>
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
