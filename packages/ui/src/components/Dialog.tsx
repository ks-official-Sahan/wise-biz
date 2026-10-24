import { useId, useRef } from "react";
import { Animated, Modal, Pressable, StyleSheet, View } from "react-native";

import { useEscapeKey } from "../a11y/useEscapeKey.ts";
import { useFocusTrap } from "../a11y/useFocusTrap.ts";
import { useOverlayTransition } from "../motion/useOverlayTransition.ts";
import { createStyles } from "../theme/createStyles.ts";
import { ABSOLUTE_FILL } from "../theme/layout.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Text } from "./Text.tsx";

import type { ReactNode } from "react";
import type { HostInstance } from "react-native";

/** Scale the dialog grows from. Never from 0. */
const DIALOG_SCALE_FROM = 0.96;

export interface DialogProps {
  readonly visible: boolean;
  /** Required: announced as the dialog name. */
  readonly title: string;
  readonly description?: string;
  /** Buttons, in order. */
  readonly actions: ReactNode;
  readonly onClose: () => void;
  readonly testID?: string;
}

const useDialogStyles = createStyles((t) => ({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: t.space[5] },
  scrim: { ...ABSOLUTE_FILL, backgroundColor: t.color.overlay },
  panel: {
    alignSelf: "stretch",
    maxWidth: t.space[11] * 8, // 512 dp on wide screens
    backgroundColor: t.color.surface,
    borderRadius: t.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    padding: t.space[5],
    gap: t.space[3],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: t.target.gap,
  },
}));

/** Centered modal. Fades and scales in on motion.enter; exits on the faster motion.exit. */
export function Dialog({ visible, title, description, actions, onClose, testID }: DialogProps) {
  const theme = useTheme();
  const styles = useDialogStyles();
  const titleId = useId();
  const descriptionId = useId();
  const transition = useOverlayTransition(visible, theme.motion, theme.motion.easeOut);
  const { progress, reduced, mounted } = transition;
  const panelRef = useRef<HostInstance>(null);
  useEscapeKey(visible, onClose);
  useFocusTrap(visible && mounted, panelRef);

  const scale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: reduced ? [1, 1] : [DIALOG_SCALE_FROM, 1],
  });
  const scrimOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, theme.color.overlayOpacity],
  });

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={styles.root}>
        <Pressable
          accessible={false}
          focusable={false}
          aria-hidden
          onPress={onClose}
          style={ABSOLUTE_FILL}
        >
          <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]} />
        </Pressable>
        <Animated.View
          ref={panelRef}
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={description === undefined ? undefined : descriptionId}
          style={[styles.panel, { opacity: progress, transform: [{ scale }] }]}
        >
          <Text nativeID={titleId} variant="heading" headingLevel={2}>
            {title}
          </Text>
          {description === undefined ? null : (
            <Text nativeID={descriptionId} variant="body" tone="muted">
              {description}
            </Text>
          )}
          <View style={styles.actions}>{actions}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}
