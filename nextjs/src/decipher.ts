import { DecipherConsole } from "./utils/decipher-console";
// Utilizing AsyncLocalStorage from Node.js to handle asynchronous context management
const { AsyncLocalStorage } = require('node:async_hooks');
import type { DecipherHandlerConfig } from './utils/handler-config';
import { withDecipher } from './decipher-error-handler';

// Creating an instance of AsyncLocalStorage to store context specific to each request
const asyncLocalStorage = new AsyncLocalStorage();
// Defining the structure of the context stored in AsyncLocalStorage
interface DecipherContext {
  // method: string;
  // url: string;
  // headers: NodeJS.Dict<string | string[]>;
  decipherConsole: DecipherConsole;
  capturedError?: Error;
  consoleMessages: any[];
}

// Singleton class to manage Decipher configurations and context
class Decipher {
  private static instance: Decipher;
  private _isProcessingLog: boolean = false;
  
  public settings: DecipherHandlerConfig = {
    codebaseId: '',
    customerId: ''
  };

  private constructor() {}

  // Ensures a single instance of the Decipher class
  public static getInstance(): Decipher {
    if (!Decipher.instance) {
      Decipher.instance = new Decipher();
    }
    return Decipher.instance;
  }

// Add logging to init method to confirm settings are being initialized
public init(config: DecipherHandlerConfig): void {
  this.settings = {
    ...this.settings,
    ...config
  };
}

// Add logging to captureError to see when errors are captured
public captureError(error: Error): void {
  const store = asyncLocalStorage.getStore();
  if (store) {
    store.capturedError = error;
  }
}

// Function to access and change processingLog state
public setProcessingLogState(state: boolean): void {
  this._isProcessingLog = state;
}

public getProcessingLogState(): boolean {
  return this._isProcessingLog;
}

// Add logging to updateContext to see updates being made
public updateContext(update: Partial<DecipherContext>): void {
  const store = asyncLocalStorage.getStore();
  if (store) {
    Object.assign(store, update);
  } else {
    console.log("[Decipher] No active async local storage to update");
  }
}

// Add logging to runWithContext to see when a new context is being run
public runWithContext(context: DecipherContext, fn: () => void): void {
  asyncLocalStorage.run(context, fn);
}

// Add logging to getCurrentContext to see when context is retrieved
public getCurrentContext(): DecipherContext | undefined {
  const context = asyncLocalStorage.getStore();
  return context;
}

public withDecipher = withDecipher;

// public withDecipher(handler: any, config: DecipherHandlerConfig): typeof handler {
//   console.log("withDecipher called within decipher.ts. Type of handler: ", typeof handler)
//   console.log("Config: ", config);
//   let response = withDecipher(handler, config);
//   console.log("Response within decipher.ts: ", response);
//   return response;
// }

}

export { asyncLocalStorage };

// Exports a singleton instance of the Decipher class
export default Decipher.getInstance();

