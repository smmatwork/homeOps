import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoverageMap } from "./CoverageMap";
import type { CoverageRow } from "../../services/coverageApi";

describe("CoverageMap", () => {
  it("shows empty state when no spaces", () => {
    render(<CoverageMap spaces={[]} rows={[]} />);
    expect(screen.getByText(/No spaces configured/i)).toBeInTheDocument();
  });

  it("renders space rows and cadence columns", () => {
    const rows: CoverageRow[] = [
      { space: "Kitchen", cadence: "daily", helperId: "h1", helperName: "Alice", deviceKeys: [], choreCount: 1 },
      { space: "Kitchen", cadence: "weekly", helperId: null, helperName: null, deviceKeys: [], choreCount: 0 },
      { space: "Kitchen", cadence: "biweekly", helperId: null, helperName: null, deviceKeys: [], choreCount: 0 },
      { space: "Kitchen", cadence: "monthly", helperId: null, helperName: null, deviceKeys: [], choreCount: 0 },
    ];
    render(<CoverageMap spaces={["Kitchen"]} rows={rows} />);

    expect(screen.getByText("Kitchen")).toBeInTheDocument();
    expect(screen.getByText("daily")).toBeInTheDocument();
    expect(screen.getByText("weekly")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("displays gap indicator for uncovered cells", () => {
    const rows: CoverageRow[] = [
      { space: "Kitchen", cadence: "daily", helperId: null, helperName: null, deviceKeys: [], choreCount: 0 },
    ];
    render(<CoverageMap spaces={["Kitchen"]} rows={rows} />);
    // At least one Gap label should appear
    const gaps = screen.getAllByText("Gap");
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("shows device coverage when devices cover the space", () => {
    const rows: CoverageRow[] = [
      { space: "Living Room", cadence: "daily", helperId: null, helperName: null, deviceKeys: ["robot_vacuum"], choreCount: 0 },
    ];
    render(<CoverageMap spaces={["Living Room"]} rows={rows} />);
    expect(screen.getByText(/1 device/)).toBeInTheDocument();
  });

  it("calls onCellClick when a cell is clicked", async () => {
    const onCellClick = vi.fn();
    const user = userEvent.setup();
    const rows: CoverageRow[] = [
      { space: "Kitchen", cadence: "daily", helperId: "h1", helperName: "Alice", deviceKeys: [], choreCount: 1 },
    ];
    render(<CoverageMap spaces={["Kitchen"]} rows={rows} onCellClick={onCellClick} />);

    await user.click(screen.getByText("Alice"));
    expect(onCellClick).toHaveBeenCalled();
    expect(onCellClick.mock.calls[0][0].space).toBe("Kitchen");
  });
});
