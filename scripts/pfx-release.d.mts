export interface AppRelease { schemaVersion: number; product: string; channel: string; version: string; label: string; commit: string; sourceDate: string; }
export function resolveRelease(): AppRelease;
export function writeRelease(outputDirectory: string): AppRelease;
export function pfxReleasePlugin(): {
  name: string;
  config(): { define: Record<string, string> };
  transformIndexHtml(html: string): string;
  generateBundle(this: { emitFile(asset: { type: "asset"; fileName: string; source: string }): unknown }): void;
};
