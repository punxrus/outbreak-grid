declare module 'mapshaper' {
  const mapshaper: {
    runCommands(commands: string): Promise<void>;
    applyCommands(commands: string, input?: Record<string, unknown>): Promise<Record<string, string | Uint8Array>>;
  };
  export default mapshaper;
}
