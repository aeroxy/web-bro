import type { CapabilityReport } from "../lib/capabilities";

export function CapabilityGate({ report }: { report: CapabilityReport }) {
  return (
    <div className="app-shell">
      <div className="panel-surface flex h-full flex-col justify-between overflow-hidden">
        <div className="panel-header">
          <div>
            <p className="panel-title">Unsupported Runtime</p>
            <h1 className="mt-2 text-3xl font-semibold text-accent-300">
              Web Bro
            </h1>
          </div>
          <span className="pill">Chromium only</span>
        </div>

        <div className="panel-body flex flex-1 flex-col justify-center gap-8">
          <div className="max-w-2xl space-y-3">
            <p className="text-base text-slate-200">
              This project intentionally targets desktop Chromium with WebGPU
              and the File System Access API. It does not provide a degraded
              fallback path.
            </p>
            <p className="text-sm text-slate-400">
              Open it on Chrome, Chromium, or Edge over HTTPS or localhost, then
              try again.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {report.reasons.map((reason) => (
              <div
                className="surface-muted rounded-3xl px-4 py-4 text-sm text-slate-300"
                key={reason}
              >
                {reason}
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="surface-muted rounded-3xl px-4 py-4 text-sm text-slate-300">
              Secure context: {report.isSecureContext ? "yes" : "no"}
            </div>
            <div className="surface-muted rounded-3xl px-4 py-4 text-sm text-slate-300">
              Directory picker: {report.hasDirectoryPicker ? "yes" : "no"}
            </div>
            <div className="surface-muted rounded-3xl px-4 py-4 text-sm text-slate-300">
              WebGPU: {report.hasWebGPU ? "yes" : "no"}
            </div>
            <div className="surface-muted rounded-3xl px-4 py-4 text-sm text-slate-300">
              Chromium: {report.isChromium ? "yes" : "no"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
