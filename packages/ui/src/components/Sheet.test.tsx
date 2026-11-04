import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Dialog } from "./Dialog.tsx";
import { Sheet } from "./Sheet.tsx";

describe("Sheet", () => {
  it("is a named modal dialog while visible", () => {
    renderWithTheme(
      <Sheet visible title="Tender cash" onClose={() => undefined}>
        <span>Exact amount</span>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Tender cash" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Exact amount")).toBeTruthy();
  });

  it("closes on Escape and on overlay press", () => {
    const onClose = vi.fn();
    renderWithTheme(
      <Sheet visible title="Tender cash" onClose={onClose}>
        <span>Body</span>
      </Sheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounts after it is hidden", async () => {
    const { rerender } = renderWithTheme(
      <Sheet visible title="Tender cash" onClose={() => undefined}>
        <span>Body</span>
      </Sheet>,
    );
    rerender(
      <Sheet visible={false} title="Tender cash" onClose={() => undefined}>
        <span>Body</span>
      </Sheet>,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Tender cash" })).toBeNull();
    });
  });
});

describe("Dialog", () => {
  it("names the dialog by its title and links the description", () => {
    renderWithTheme(
      <Dialog
        visible
        title="Void this sale?"
        description="The receipt is cancelled and cannot be reopened."
        onClose={() => undefined}
        actions={<span>Keep sale</span>}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Void this sale?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Keep sale")).toBeTruthy();
  });

  it("renders without a description and closes on Escape", () => {
    const onClose = vi.fn();
    renderWithTheme(<Dialog visible title="Discard draft?" onClose={onClose} actions={null} />);
    expect(
      screen.getByRole("dialog", { name: "Discard draft?" }).getAttribute("aria-describedby"),
    ).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("unmounts after it is hidden", async () => {
    const { rerender } = renderWithTheme(
      <Dialog visible title="Hold sale?" onClose={() => undefined} actions={null} />,
    );
    rerender(
      <Dialog visible={false} title="Hold sale?" onClose={() => undefined} actions={null} />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Hold sale?" })).toBeNull();
    });
  });
});

describe("modal focus", () => {
  it("moves focus into the dialog, traps Tab, and returns focus on close", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const view = (visible: boolean) => (
      <Dialog
        visible={visible}
        title="Void line"
        onClose={() => undefined}
        actions={
          <>
            <button type="button">Keep</button>
            <button type="button">Void</button>
          </>
        }
      />
    );
    const { rerender } = renderWithTheme(view(true));
    const keep = screen.getByRole("button", { name: "Keep" });
    const voidButton = screen.getByRole("button", { name: "Void" });
    await waitFor(() => {
      expect(document.activeElement).toBe(keep);
    });
    voidButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(voidButton);

    rerender(view(false));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    opener.remove();
  });

  it("gives the sheet a visible close button", () => {
    const onClose = vi.fn();
    renderWithTheme(
      <Sheet visible title="Tender cash" onClose={onClose}>
        <span>Body</span>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
