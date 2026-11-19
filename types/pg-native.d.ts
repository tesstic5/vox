declare module 'pg-native' {
  export default class Client {
    connectSync(connectionString?: string): void;
    querySync<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: Array<string | null>): T[];
    prepareSync(name: string, text: string, parameterCount: number): void;
    executeSync<T extends Record<string, unknown> = Record<string, unknown>>(name: string, values?: Array<string | null>): T[];
    end(): void;
  }
}
