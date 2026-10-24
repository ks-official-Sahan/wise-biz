import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { TextField } from "./TextField.tsx";

describe("TextField", () => {
  it("is found by its visible label and reports changes", () => {
    const onChangeText = vi.fn();
    renderWithTheme(
      <TextField label="Customer name" value="" onChangeText={onChangeText} placeholder="Ayu" />,
    );
    const input = screen.getByRole("textbox", { name: "Customer name" });
    fireEvent.change(input, { target: { value: "Ayu P" } });
    expect(onChangeText).toHaveBeenCalledWith("Ayu P");
  });

  it("links helper text and reports aria-invalid with an error", () => {
    renderWithTheme(
      <TextField
        label="Price"
        value="-1"
        onChangeText={() => undefined}
        helper="In LKR"
        error="Price must be positive"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Price" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toHaveLength(1);
    expect(screen.getByText("Price must be positive")).toBeTruthy();
    expect(screen.queryByText("In LKR")).toBeNull();
  });

  it("links both helper and error when both exist", () => {
    renderWithTheme(
      <TextField
        label="Price"
        value=""
        onChangeText={() => undefined}
        helper="In LKR"
        error="Required"
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Price" }).getAttribute("aria-describedby")?.split(" "),
    ).toHaveLength(1);
  });

  it("describes the helper text without an error and shows focus and blur state", () => {
    renderWithTheme(
      <TextField label="SKU" value="" onChangeText={() => undefined} helper="Scan or type" />,
    );
    const input = screen.getByRole("textbox", { name: "SKU" });
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.getByText("Scan or type")).toBeTruthy();
  });

  it("has no described-by link when there is neither helper nor error", () => {
    renderWithTheme(
      <TextField
        label="Note"
        value=""
        onChangeText={() => undefined}
        keyboardType="default"
        autoCapitalize="sentences"
        secureTextEntry={false}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Note" }).getAttribute("aria-describedby"),
    ).toBeNull();
  });
});
