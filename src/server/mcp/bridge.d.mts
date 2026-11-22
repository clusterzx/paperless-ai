/** Types of bridge.mjs (plain JavaScript, so it can be downloaded and run on its own). */
export declare function bridgeOptions(argv: string[], env: Record<string, string | undefined>): { url: string; key: string };

export declare function runBridge(o: {
  url: string;
  key: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<number>;
