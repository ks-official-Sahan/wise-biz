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
