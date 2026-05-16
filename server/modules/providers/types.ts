export interface ISessionSynchronizer {
  provider: string;
  watchPaths: string[];
  synchronize(since: Date | null): Promise<number>;
  synchronizeFile(filePath: string): Promise<string | null>;
}
