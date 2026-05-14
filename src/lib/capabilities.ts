export interface CapabilityReport {
  supported: boolean;
  isSecureContext: boolean;
  hasDirectoryPicker: boolean;
  hasWebGPU: boolean;
  hasChromeAI: boolean;
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

function detectChromeAI(): boolean {
  const g = globalThis as unknown as {
    LanguageModel?: { availability?: unknown };
  };
  return typeof g.LanguageModel?.availability === "function";
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
  const hasChromeAI = detectChromeAI();
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

  if (!hasWebGPU && !hasChromeAI) {
    reasons.push(
      "Need either WebGPU (for in-browser Gemma) or Chrome's built-in Prompt API (Gemini Nano).",
    );
  }

  return {
    supported:
      isSecure &&
      hasDirectoryPicker &&
      isChromium &&
      (hasWebGPU || hasChromeAI),
    isSecureContext: isSecure,
    hasDirectoryPicker,
    hasWebGPU,
    hasChromeAI,
    isChromium,
    reasons,
  };
}
