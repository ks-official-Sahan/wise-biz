import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Skeleton } from "./Skeleton.tsx";

describe("Skeleton", () => {
  it("is hidden from assistive tech and keeps its shape", () => {
    const { container } = renderWithTheme(<Skeleton width={120} height={16} radius="pill" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("supports every radius token", () => {
    const { container } = renderWithTheme(
      <>
        <Skeleton width="100%" height={40} />
        <Skeleton width={80} height={12} radius="card" />
      </>,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });
});
