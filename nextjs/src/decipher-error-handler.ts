import type { NextApiRequest, NextApiResponse } from "next";
import { NextRequest, NextResponse } from "next/server";
import { collectAndSend, collectAndSendTrpc } from "./utils/collect-and-send";
import { DecipherConsole } from "./utils/decipher-console";
import { DecipherHandlerConfig } from "./utils/handler-config";
import Decipher from "./decipher";

type AppRouterRequestHandler = (
  request: Request
) => Response | Promise<Response> | NextResponse | Promise<NextResponse>;

type AppRouterNextRequestHandler = (
  request: NextRequest
) => Response | Promise<Response> | NextResponse | Promise<NextResponse>;

/* App router wrapper: */
export function withDecipher(
  handler: AppRouterRequestHandler | AppRouterNextRequestHandler,
  config: DecipherHandlerConfig
): typeof handler;

export function withDecipher(
  handler: AppRouterRequestHandler | AppRouterNextRequestHandler,
  config: DecipherHandlerConfig
): typeof handler {
  const filledConfig = {
    ...Decipher.settings,
    excludeRequestBody: !!config.excludeRequestBody,
    environment: config.environment || "production",
  };
  return async (request: Request | NextRequest) => {
    let decipherRequest = request;
    let handlerInvoked = false;

    let responseBody: any;
        return await Decipher.runWithContext({
          // method: request.method,
          // url: request.url,
          // headers: {},
          consoleMessages: [],
          decipherConsole: new DecipherConsole(),
        },
        async () => {
          try {
            console.log("[Decipher] inside Decipher.runWithContext")
            const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
            currentContext?.decipherConsole.instrumentConsole(); // Instrument the console for capturing logs
            currentContext?.decipherConsole.clearMessages(); // Clear any previous messages

            handlerInvoked = true;
            if (!filledConfig.excludeRequestBody) {
              // Clone the request if we're capturing body, so that we can
              // access the body stream without affecting the original request's stream.
              decipherRequest = request.clone();
            }
            console.log('[Decipher] calling the handler')
            const response = await handler(request as any); // Run the handler as normal.
            if (!response.ok) {
              console.log('[Decipher] response not ok: ', response.status)
              const clonedResponse = response.clone();
              try {
                responseBody = await clonedResponse.json();
                console.log('[Decipher] response not ok, responseBody:', responseBody)
              } catch (jsonParseError) {
                responseBody = "Unknown error; json parsing failed.";
              }
              // Identified a non-2xx response, which may be an exception that the handler caught.
              // Collect the request/response data and send it to Decipher.
              collectAndSend(decipherRequest, {
                respBody: responseBody,
                statusCode: response.status,
                messages: currentContext?.consoleMessages || [], 
                isUncaughtException: false,
                config: filledConfig,
                error: currentContext?.capturedError
              });
            }
            console.log('[Decipher] returning the response:', response)
            return response;
          } catch (error) {
            console.log('[Decipher] found an error')
            if (handlerInvoked) {
              // This branch handles uncaught exceptions thrown by the handler; these have stack traces.
              // Collect the request/response data and send it to Decipher.
              if (error instanceof Error) {
                const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
                const errorToSend = currentContext?.capturedError || error; // Determine the error to send
                if (currentContext?.decipherConsole) {
                  collectAndSend(decipherRequest, {
                    respBody: responseBody,
                    statusCode: 500,
                    messages: currentContext?.consoleMessages || [], 
                    isUncaughtException: true,
                    config: filledConfig,
                    error: errorToSend
                  });
                }
                throw error;
              } else {
                // This else condition is needed because it's possible to throw non-Error objects
                // e.g. `throw "error happened"` (string)
                const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
                if (currentContext?.decipherConsole) {
                  collectAndSend(decipherRequest, {
                    respBody: error,
                    statusCode: 500,
                    messages: currentContext?.consoleMessages || [], 
                    isUncaughtException: true,
                    config: filledConfig,
                    error: currentContext?.capturedError
                  });
                }
              }
            } else {
              console.log('[Decipher] something went wrong in Else')
              // Something went wrong with Decipher's initialization logic; just run the handler as normal and
              // return the result.
              const result = await handler(request as any);
              return result;
            }
          } finally {
            const currentContext = Decipher.getCurrentContext();
            if (currentContext) {
              currentContext.decipherConsole.resetConsole(); // Reset the console to its original state
              currentContext.decipherConsole.clearMessages(); // Clear captured console messages
            }
          }
          console.log('[Decipher] returning a new promise')
          return new Response();
        });
  };
}

type PageRouterHandler<T> = (
  req: NextApiRequest,
  res: NextApiResponse<T>
) => void | NextApiResponse<T> | Promise<void | NextApiResponse<T>>;

/* Page router wrapper: */
export function wrapApiHandlerWithDecipher<T>(
  handler: PageRouterHandler<T>,
  config: DecipherHandlerConfig
): typeof handler;

export function wrapApiHandlerWithDecipher<T>(
  handler: PageRouterHandler<T>,
  config: DecipherHandlerConfig
): typeof handler {
  const filledConfig = {
    ...config,
    excludeRequestBody: !!config.excludeRequestBody,
    environment: config.environment || "production",
  };

  return async (req: NextApiRequest, res: NextApiResponse<T>) => {
    let originalConsole;
    let decipherConsole;
    let handlerInvoked = false;

    let responseBody: any;

    try {
      decipherConsole = new DecipherConsole();
      decipherConsole.instrumentConsole();
      originalConsole = console;

      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        // Capture the responseBody; only used in case of uncaught exceptions and non-200s.
        responseBody = body;
        return originalJson(body);
      };
      const originalSend = res.send.bind(res);
      res.send = (body?: any) => {
        // Capture the responseBody if body is provided; only used in case of uncaught exceptions and non-200s.
        if (body) {
          responseBody = body;
        }
        return originalSend(body);
      };
      const originalEnd = res.end.bind(res);
      res.end = (body?: any) => {
        // Capture the responseBody if body is provided; only used in case of uncaught exceptions and non-200s.
        if (body) {
          responseBody = body;
        }
        return originalEnd(body);
      };

      handlerInvoked = true;
      const result = await handler(req, res); // Run the handler as normal.
      // 200s are OK and get returned as normal.
      if (!res.statusCode || (res.statusCode >= 200 && res.statusCode < 300)) {
        return result;
      } else {
        // Identified a non-200 (which may be an exception that the handler caught).
        // Collect the request/response data and send it to Decipher.
        const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
        collectAndSend(req, {
          respBody: responseBody,
          statusCode: res.statusCode,
          messages: decipherConsole.getMessages(),
          isUncaughtException: false,
          config: filledConfig,
          error: currentContext?.capturedError
        });
        return result;
      }
    } catch (error) {
      if (handlerInvoked) {
        // This branch handles uncaught exceptions thrown by the handler; these have stack traces.
        // Collect the request/response data and send it to Decipher.
        const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
        if (error instanceof Error) {
          const errorToSend = currentContext?.capturedError || error; // Determine the error to send
          if (decipherConsole) {
            collectAndSend(req, {
              respBody: responseBody,
              statusCode: 500,
              messages: decipherConsole.getMessages(),
              isUncaughtException: true,
              config: filledConfig,
              error: errorToSend,
            });
          }
        } else {
          // This else condition is needed because it's possible to throw non-Error objects
          // e.g. `throw "error happened"` (string)
          if (decipherConsole) {
            collectAndSend(req, {
              respBody: error,
              statusCode: 500,
              messages: decipherConsole.getMessages(),
              isUncaughtException: true,
              config: filledConfig,
              error: currentContext?.capturedError
            });
          }
        }
        throw error;
      } else {
        // Something went wrong with Decipher's initialization logic; just run the handler as normal and
        // return the result.
        const result = await handler(req, res);
        return result;
      }
    } finally {
      // After the request is handled, restore the original console methods
      if (originalConsole) {
        console = originalConsole;
      }
      if (decipherConsole) {
        decipherConsole.clearMessages();
      }
    }
  };
}

export function decipherTrpcMiddleware(config: DecipherHandlerConfig) {
  return async (opts: any) => {
    let originalConsole;
    let decipherConsole;
    let handlerInvoked = false;
    let result : any;
    const filledConfig = {
      ...config,
      excludeRequestBody: !!config.excludeRequestBody,
      environment: config.environment || "production",
    };
    try {
      return await Decipher.runWithContext({
        consoleMessages: [],
        decipherConsole: new DecipherConsole(),
      }, async () => {
        try {
          const currentContext = Decipher.getCurrentContext(); // Retrieve the current context
          currentContext?.decipherConsole.instrumentConsole(); // Instrument the console for capturing logs
          currentContext?.decipherConsole.clearMessages(); // Clear any previous messages

          // Proceed with the next middleware or the actual procedure
          result = await opts.next();

          if (!result.ok) {
            if (result.error instanceof Error) {
              collectAndSendTrpc(opts, {
                respBody: {},
                statusCode: 500,
                messages: currentContext?.consoleMessages || [], 
                isUncaughtException: true,
                config: filledConfig,
                error: result.error,
              });
            } else {
              collectAndSendTrpc(opts, {
                respBody: result.error,
                statusCode: 500,
                messages: currentContext?.consoleMessages || [], 
                isUncaughtException: true,
                config: filledConfig,
              });
            }
          }
          return result;
        } catch (error) {
          if (!handlerInvoked) {
            // Caught an error in Decipher's logic BEFORE handler invocation above. The handler won't throw an error
            // if it was an invoked given tRPC's error-handling mechanism.
            return await opts.next();
          } else {
            // Caught an error in Decipher's logic AFTER handler invocation above. The handler won't throw an error
            // if it was an invoked given tRPC's error-handling mechanism.
            return result;
          }
        } finally {
          const currentContext = Decipher.getCurrentContext();
          if (currentContext) {
            currentContext.decipherConsole.resetConsole(); // Reset the console to its original state
            currentContext.decipherConsole.clearMessages(); // Clear captured console messages
          }
        }
      });
    } catch {
        console.log('[Decipher] error in the catch block 3')
        return new Response();
    }
  }; 
}