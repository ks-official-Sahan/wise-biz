import { Badge, Button, Text, createStyles } from "@wise-biz/ui";
import { Component } from "react";
import { Pressable, View } from "react-native";

import { useController } from "./context.tsx";
import { useOnline, useSyncHealth } from "./hooks.ts";

import type { SyncHealth } from "@wise-biz/sync";
import type { ReactNode } from "react";

const useStyles = createStyles((t) => ({
  banner: {
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[2],
    backgroundColor: t.color.warningSubtle,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: t.space[6],
    gap: t.space[3],
  },
}));

/** Offline is normal for a POS: selling continues. The banner says so, in words, never by color alone. */
export function OfflineBanner() {
  const online = useOnline();
  const styles = useStyles();
  if (online) return null;
  return (
    <View role="status" style={styles.banner} testID="offline-banner">
      <Text variant="label" tone="warning">
        Offline. Sales are saved on this device and sent when the connection returns.
      </Text>
    </View>
  );
}

interface Chip {
  tone: "success" | "warning" | "danger" | "info";
  label: string;
}

/** One word of sync state for the header. Counts are exact; wording never blames the cashier. */
export function describeSync(h: SyncHealth | undefined, online: boolean): Chip {
  if (h === undefined) return { tone: "info", label: "Starting sync" };
  if (h.push === "blocked") return { tone: "danger", label: "Sync stopped: contact the owner" };
  if (h.push === "auth") return { tone: "warning", label: "Sign in again to sync" };
  if (h.pendingBootstrap.length > 0) return { tone: "info", label: "First sync in progress" };
  if (h.unsyncedCount > 0) {
    return {
      tone: online ? "info" : "warning",
      label: `${String(h.unsyncedCount)} waiting to sync`,
    };
  }
  return online
    ? { tone: "success", label: "Synced" }
    : { tone: "warning", label: "Offline, nothing waiting" };
}

export function SyncChip() {
  const controller = useController();
  const online = useOnline();
  const health = useSyncHealth();
  const { tone, label } = describeSync(health, online);
  return (
    <Pressable
      role="button"
      aria-label={`Sync status: ${label}. Press to sync now.`}
      testID="sync-chip"
      onPress={() => {
        controller.nudge();
      }}
    >
      <Badge tone={tone} label={label} />
    </Pressable>
  );
}

interface BoundaryState {
  failed: boolean;
}

/** Last line of defence: a render error shows a calm screen instead of a white one, and reports once. */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: (e: unknown) => void },
  BoundaryState
> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.failed)
      return (
        <FailedView
          onRetry={() => {
            this.setState({ failed: false });
          }}
        />
      );
    return this.props.children;
  }
}

function FailedView({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.center} role="alert">
      <Text variant="title" headingLevel={1}>
        Something went wrong
      </Text>
      <Text tone="muted">
        Your sales are safe on this device. Try again; if it keeps happening, restart the app.
      </Text>
      <Button label="Try again" onPress={onRetry} testID="retry" />
    </View>
  );
}
