import { useId, useState } from "react";
import { Animated, Modal, Pressable, View } from "react-native";

import { useEscapeKey } from "../a11y/useEscapeKey.ts";
import { useOverlayTransition } from "../motion/useOverlayTransition.ts";
import { createStyles } from "../theme/createStyles.ts";
import { ABSOLUTE_FILL } from "../theme/layout.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Text } from "./Text.tsx";

import type { ReactNode } from "react";

export interface SheetProps {
  readonly visible: boolean;
  /** Required: announced as the dialog name. */
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  readonly testID?: string;
}

const useSheetStyles = createStyles((t) => ({
  root: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...ABSOLUTE_FILL, backgroundColor: t.color.overlay },
  panel: {
    backgroundColor: t.color.surface,
    borderTopLeftRadius: t.radius.card,
    borderTopRightRadius: t.radius.card,
    padding: t.space[5],
    gap: t.space[4],
  },
}));

/** Bottom sheet on a transparent Modal. Slides in on motion.easeSheet; reduced motion fades instead. */
export function Sheet({ visible, title, onClose, children, testID }: SheetProps) {
  const theme = useTheme();
  const styles = useSheetStyles();
  const titleId = useId();
  const [height, setHeight] = useState(0);
  const transition = useOverlayTransition(visible, theme.motion, theme.motion.easeSheet);
  const { progress, reduced, mounted } = transition;
  useEscapeKey(visible, onClose);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: reduced ? [0, 0] : [height, 0],
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
        <Pressable accessible={false} aria-hidden onPress={onClose} style={ABSOLUTE_FILL}>
          <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]} />
        </Pressable>
        <Animated.View
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          onLayout={(event) => {
            setHeight(event.nativeEvent.layout.height);
          }}
          style={[styles.panel, { opacity: progress, transform: [{ translateY }] }]}
        >
          <Text nativeID={titleId} variant="heading" headingLevel={2}>
            {title}
          </Text>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
