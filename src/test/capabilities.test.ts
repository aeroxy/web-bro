import { describe, expect, it } from "vitest";

import { getCapabilityReport } from "../lib/capabilities";

describe("getCapabilityReport", () => {
  it("marks unsupported browsers clearly", () => {
    const originalShowDirectoryPicker = window.showDirectoryPicker;
    const nav = navigator as Navigator & { gpu?: unknown };
    const originalGpu = nav.gpu;
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "isSecureContext",
    );

    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    window.showDirectoryPicker = undefined;
    Object.defineProperty(nav, "gpu", {
      configurable: true,
      value: undefined,
    });

    const report = getCapabilityReport();

    expect(report.supported).toBe(false);
    expect(report.reasons.length).toBeGreaterThan(0);

    if (descriptor) {
      Object.defineProperty(window, "isSecureContext", descriptor);
    }
    window.showDirectoryPicker = originalShowDirectoryPicker;
    Object.defineProperty(nav, "gpu", {
      configurable: true,
      value: originalGpu,
    });
  });
});
