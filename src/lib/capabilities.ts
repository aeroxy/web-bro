export interface CapabilityReport {
  supported: boolean;
  isSecureContext: boolean;
  hasDirectoryPicker: boolean;
  hasWebGPU: boolean;
  isChromium: boolean;
  reasons: string[];
}

function detectChromium(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const nav = navigator as Navigator & {
    gpu?: unknown;
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
    };
  };
  const brands = nav.userAgentData?.brands ?? [];

  if (brands.some((brand) => /Chrom(e|ium)|Edge/i.test(brand.brand))) {
    return true;
  }

  return /Chrome|Chromium|Edg/i.test(navigator.userAgent);
}

export function getCapabilityReport(): CapabilityReport {
  const isSecure =
    typeof window !== "undefined" ? window.isSecureContext : false;
  const hasDirectoryPicker =
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function";
  const nav = navigator as Navigator & { gpu?: unknown };
  const hasWebGPU =
    typeof navigator !== "undefined" && "gpu" in nav && nav.gpu !== undefined;
  const isChromium = detectChromium();
  const reasons: string[] = [];

  if (!isSecure) {
    reasons.push("This app must run in a secure context (HTTPS or localhost).");
  }

  if (!isChromium) {
    reasons.push("V1 is intentionally desktop-Chromium only.");
  }

  if (!hasDirectoryPicker) {
    reasons.push(
      "Your browser does not expose the File System Access directory picker.",
    );
  }

  if (!hasWebGPU) {
    reasons.push("WebGPU is required for the in-browser Qwen runtime.");
  }

  return {
    supported: isSecure && hasDirectoryPicker && hasWebGPU && isChromium,
    isSecureContext: isSecure,
    hasDirectoryPicker,
    hasWebGPU,
    isChromium,
    reasons,
  };
}
