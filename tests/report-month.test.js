import { describe, expect, it } from "vitest";
import { monthKey, monthLabel } from "@/lib/report-month";
import { buildCoverage, reportPdf } from "@/lib/report-export";

describe("report month keys", () => {
  it("normalises the Date objects returned by postgres", () => {
    expect(monthKey(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });

  it("keeps ISO date and month strings stable", () => {
    expect(monthKey("2026-09-01")).toBe("2026-09");
    expect(monthKey("2026-09")).toBe("2026-09");
  });

  it("marks coverage filed when postgres returns a Date month", () => {
    const coverage = buildCoverage({
      departments: [{ id: "d1", name: "Web", vertical: "technical" }],
      reports: [{ department_id: "d1", month: new Date("2026-09-01T00:00:00.000Z") }],
      months: ["2026-09"]
    });

    expect(coverage[0].months).toEqual([{ month: "2026-09", status: "submitted" }]);
  });

  it("formats a postgres Date as a human month label", () => {
    expect(monthLabel(new Date("2026-09-01T00:00:00.000Z"))).toBe("September 2026");
  });

  it("uses the normalised month in the PDF heading", () => {
    const pdf = reportPdf({
      scope: "semester",
      months: ["2026-09"],
      since: "2026-09-01",
      exported_at: "2026-10-01T00:00:00.000Z",
      tenant_id: "11111111-1111-1111-1111-111111111111",
      submitted_reports: [{
        id: "r1",
        department_id: "d1",
        department_name: "Web",
        vertical: "technical",
        month: new Date("2026-09-01T00:00:00.000Z"),
        status: "submitted",
        submitted_by_name: "Asha",
        submitted_at: "2026-10-01T00:00:00.000Z",
        narrative: "",
        draft: {}
      }],
      departments: [{ id: "d1", name: "Web", vertical: "technical" }],
      contribution_counts: [],
      membership_counts: [],
      coverage: [],
      totals: { submitted_reports: 1, departments: 1, missing_months: 0, contributions: 0 }
    }).toString("latin1");

    expect(pdf).toContain("Web - September 2026");
  });
});
